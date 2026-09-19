#!/usr/bin/env python3
"""Disk joins and bounded aggregations for large runs; never load all requests."""
import collections
import datetime
import heapq
import json
import math
import os
from pathlib import Path
import sqlite3
import sys
import tempfile

def finite(v):
    return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)

def iso(ms):
    return datetime.datetime.fromtimestamp(ms / 1000, datetime.timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')

def epoch(value):
    try:
        return datetime.datetime.fromisoformat(value.replace('Z', '+00:00')).timestamp() * 1000
    except (ValueError, TypeError, AttributeError):
        return None

class Distribution:
    # Geometric buckets: <0.1% relative error above 1 ms, <=0.001 below.
    def __init__(self):
        self.bins = collections.Counter()
        self.count = 0

    def add(self, value):
        if finite(value) and value >= 0:
            self.bins[math.ceil(math.log1p(value) / math.log(1.001))] += 1
            self.count += 1

    def result(self):
        out = dict(count=self.count, p50=None, p95=None, p99=None)
        if not self.count:
            return out
        targets = {k: math.ceil(self.count * p) for k, p in [('p50', .5), ('p95', .95), ('p99', .99)]}
        seen = 0
        for bucket, count in sorted(self.bins.items()):
            seen += count
            for key, target in targets.items():
                if out[key] is None and seen >= target:
                    out[key] = math.expm1(bucket * math.log(1.001))
        return out

class Summary:
    def __init__(self):
        self.counts = collections.Counter()
        self.errors = collections.Counter()
        self.reasons = collections.Counter()
        self.dist = {k: Distribution() for k in ['successLatency', 'allLatency', 'successTtfb', 'successTtft', 'contentGaps', 'inputChars', 'outputTokenDistribution']}

    def add(self, r):
        c = self.counts
        c['issued'] += 1
        result = r['result']
        c[{'ok':'succeeded', 'fail':'failed', 'cancelled':'cancelled'}.get(result, 'unresolved')] += 1
        if result == 'fail':
            self.errors[r.get('errorType') or 'unknown'] += 1
        self.reasons[r.get('finishReason') or 'unknown'] += 1
        if r.get('stream'):
            c['streamCount'] += 1
            c['ttftMeasured'] += int(finite(r.get('ttftMs')))
        if r.get('usage') is not None:
            c['usageKnown'] += 1
            c['inputTokens'] += r['usage'].get('input', 0)
            c['outputTokens'] += r['usage'].get('output', 0)
            self.dist['outputTokenDistribution'].add(r['usage'].get('output'))
        else:
            c['usageMissing'] += 1
        self.dist['inputChars'].add(r.get('inputChars'))
        self.dist['allLatency'].add(r.get('totalMs'))
        if result == 'ok':
            for dest, src in [('successLatency','totalMs'), ('successTtfb','ttfbMs')]:
                self.dist[dest].add(r.get(src))
            if r.get('stream'):
                self.dist['successTtft'].add(r.get('ttftMs'))
                self.dist['contentGaps'].add(r.get('maxContentGapMs'))

    def result(self):
        out = {k:self.counts[k] for k in ['issued','succeeded','failed','cancelled','unresolved','streamCount','ttftMeasured','usageKnown','usageMissing','inputTokens','outputTokens']}
        out.update(successRate=out['succeeded']/out['issued'] if out['issued'] else None, errors=dict(self.errors), finishReasons=dict(self.reasons))
        out.update({k:d.result() for k,d in self.dist.items()})
        return out

class Activity:
    def __init__(self, window, end):
        self.window = window
        self.end = min(window['endMs'], end)
        self.seconds = max(0, self.end-window['startMs'])/1000
        self.counts = collections.Counter()
        self.heap = []
        self.peak = 0
        self.area = 0

    def add(self, r, end):
        a, b = self.window['startMs'], self.end
        start, finish = r['startMs'], r.get('endMs')
        if a <= start < b:
            self.counts['issued'] += 1
        if finite(finish) and a <= finish < b:
            self.counts['completed'] += 1
            self.counts['succeeded'] += int(r['result']=='ok')
            if r.get('usage') is None:
                self.counts['usageMissing'] += 1
            else:
                self.counts['inputTokens'] += r['usage'].get('input',0)
                self.counts['outputTokens'] += r['usage'].get('output',0)
        first, last = max(a,start), min(b,finish if finite(finish) else end)
        if first < last:
            self.area += last-first
            while self.heap and self.heap[0] <= first:
                heapq.heappop(self.heap)
            heapq.heappush(self.heap,last)
            self.peak = max(self.peak,len(self.heap))

    def result(self):
        c, seconds = self.counts,self.seconds
        out = dict(self.window, observedSeconds=seconds, **{k:c[k] for k in ['issued','completed','succeeded','usageMissing']})
        for target, source in [('issuedRps','issued'),('completedRps','completed'),('successRps','succeeded'),('inputTokensPerSecond','inputTokens'),('outputTokensPerSecond','outputTokens')]:
            out[target] = c[source]/seconds if seconds else None
        out.update(averageInflight=self.area/(seconds*1000) if seconds else None,peakInflight=self.peak)
        return out

def main():
    meta_path, events_path, requests_path, stream_path, output, end = sys.argv[1:]
    meta = json.loads(Path(meta_path).read_text())
    plan = meta['plan']
    issues = collections.Counter()
    with tempfile.TemporaryDirectory(prefix='perf-report-') as tmp:
        db = sqlite3.connect(str(Path(tmp)/'join.sqlite'))
        db.executescript('PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF; PRAGMA cache_size=-32768; PRAGMA temp_store=FILE; CREATE TABLE starts(id TEXT PRIMARY KEY, at REAL, raw TEXT); CREATE TABLE ends(id TEXT PRIMARY KEY, at REAL, raw TEXT); CREATE TABLE meters(id TEXT PRIMARY KEY, raw TEXT);')
        batches = {'starts':[], 'ends':[], 'meters':[]}
        def flush(table):
            rows = batches[table]
            if not rows: return
            before = db.total_changes
            db.executemany('INSERT OR IGNORE INTO '+table+' VALUES ('+','.join(['?']*len(rows[0]))+')',rows)
            issues['duplicate '+table] += len(rows)-(db.total_changes-before)
            rows.clear()
            db.commit()
        print('Indexing request events on disk...', flush=True)
        last = 0
        for line in open(events_path):
            if not line.strip(): continue
            try:
                outer = json.loads(line)
                r = json.loads(outer['msg']) if 'msg' in outer else outer
                if r.get('schema') != 1 or r.get('kind') not in ('start','end') or not isinstance(r.get('id'),str): raise ValueError()
                at = r.get('startMs' if r['kind']=='start' else 'endMs')
                if not finite(at): raise ValueError()
                table = 'starts' if r['kind']=='start' else 'ends'
                batches[table].append((r['id'],at,json.dumps(r,separators=(',',':'))))
                last = max(last,at)
                if len(batches[table]) >= 10000: flush(table)
            except (ValueError,KeyError,TypeError,AttributeError): issues['malformed event lines'] += 1
        flush('starts'); flush('ends')
        if stream_path != '-' and Path(stream_path).exists():
            print('Indexing stream measurements on disk...', flush=True)
            for line in open(stream_path):
                if not line.strip(): continue
                try:
                    r=json.loads(line)
                    if not isinstance(r.get('id'),str): raise ValueError()
                    batches['meters'].append((r['id'],line.strip()))
                    if len(batches['meters'])>=10000:flush('meters')
                except (ValueError,KeyError,TypeError,AttributeError):issues['malformed stream measurements']+=1
            flush('meters')
        end = max(float(end),last)
        totals=Summary();cohorts={w['id']:Summary() for w in plan['windows']};groups={};error_details={};error_reasons=collections.Counter()
        activity=[Activity(w,end) for w in plan['windows']]
        drain=Activity({'id':'drain','startMs':plan['durationMs'],'endMs':max(plan['durationMs'],end)+.001},end+.001)
        plan_start=None
        issues['end events without start']=db.execute('SELECT count(*) FROM ends e LEFT JOIN starts s ON e.id=s.id WHERE s.id IS NULL').fetchone()[0]
        issues['stream measurements without start']=db.execute('SELECT count(*) FROM meters m LEFT JOIN starts s ON m.id=s.id WHERE s.id IS NULL').fetchone()[0]
        print('Joining and aggregating requests with bounded memory...',flush=True)
        db.execute('CREATE INDEX start_order ON starts(at)')
        query='SELECT s.raw,e.raw,m.raw FROM starts s LEFT JOIN ends e ON e.id=s.id LEFT JOIN meters m ON m.id=s.id ORDER BY s.at'
        with open(requests_path,'w') as out:
            os.chmod(requests_path,0o600)
            for index,(start_raw,end_raw,meter_raw) in enumerate(db.execute(query)):
                r=json.loads(start_raw); e=json.loads(end_raw) if end_raw else {}
                r.update(e); r['result']=e.get('result','unresolved'); r['endMs']=e.get('endMs');r['usage']=e.get('usage')
                if finite(r['endMs']) and r['endMs']<r['startMs']:
                    issues['invalid timestamps']+=1;continue
                if r.get('result')=='fail' and finite(r.get('status')) and 300<=r['status']<=599:
                    status=r['status'];r['originalErrorType']=r.get('errorType');r['errorType']='http_429' if status==429 else 'http_5xx' if status>=500 else 'http_4xx'
                if meter_raw:
                    m=json.loads(meter_raw)
                    for k in ['ttftMs','maxContentGapMs','contentEvents','receivedBytes']:r[k]=m.get(k)
                    r['meterResult']=m.get('result')
                    if m.get('errorReason'):r['errorReason']=m['errorReason']
                    if r['result']=='fail' and m.get('errorType') in ('client_error','client_timeout'):
                        r['meterTransportError']=m['errorType'];r['errorType']=m['errorType']
                    if r['result']=='ok' and m.get('result')!='ok':issues['meter disagrees with successful request']+=1
                elif stream_path!='-' and r.get('stream'):issues['missing stream measurements']+=1
                if plan_start is None and epoch(r.get('startTime')) is not None:plan_start=iso(epoch(r['startTime'])-r['startMs'])
                r.pop('kind',None)
                out.write(json.dumps(r,separators=(',',':'))+'\n')
                totals.add(r)
                if r.get('window') in cohorts:cohorts[r['window']].add(r)
                else:issues['requests outside planned windows']+=1
                key=(r.get('window'),r.get('model'),r.get('stream'))
                if key not in groups:groups[key]=Summary()
                groups[key].add(r)
                for w in activity:w.add(r,end)
                drain.add(r,end)
                if r['result']=='fail':
                    if r.get('errorReason'):error_reasons[r['errorReason']]+=1
                    key=(r.get('errorType'),r.get('errorCode'));at=epoch(r.get('endTime'))
                    if key not in error_details:error_details[key]=dict(type=key[0],code=key[1],count=0,firstAt=None,lastAt=None)
                    err=error_details[key];err['count']+=1
                    if at is not None:
                        if err['firstAt'] is None or at<epoch(err['firstAt']):err['firstAt']=iso(at)
                        if err['lastAt'] is None or at>epoch(err['lastAt']):err['lastAt']=iso(at)
                if index and index%500000==0:print(f'Aggregated {index:,} requests...',flush=True)
        result=dict(totals=totals.result(),cohorts=[dict(w,**cohorts[w['id']].result()) for w in plan['windows']],activity=[a.result() for a in activity],drain=drain.result(),
                    groups=[dict(window=k[0],model=k[1],stream=k[2],**v.result()) for k,v in groups.items()],errorDetails=list(error_details.values()),runEndMs=end,plannedDurationMs=plan['durationMs'],planStartedAt=plan_start,
                    issues=[f'{v} {k}' for k,v in issues.items() if v],errorReasons=dict(error_reasons),aggregation='disk-backed; percentile upper bounds from log1p buckets, <=0.1%*(1+value) error; counts and window rates exact')
        Path(output).write_text(json.dumps(result,ensure_ascii=False))
        db.close()

if __name__=='__main__':main()
