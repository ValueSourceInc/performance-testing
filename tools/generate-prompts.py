#!/usr/bin/env python3
"""生成真实感 prompt 样本文件（PROMPTS_FILE 格式：每行一条，不含换行）。

new-api 尚未上线、没有真实流量可导出时用本脚本生成。内容按内部 LLM 网关
典型用途分布（中文电商运营/办公/开发混合），大小分布对齐真实请求体形态：
约 30% 短指令、30% 中等任务、25% 长文档、15% 超长上下文。

用法: python3 tools/generate-prompts.py > samples/real-prompts.txt [--count 150]
"""
import random
import sys

random.seed(20260919)

COUNT = 150
if '--count' in sys.argv:
    COUNT = int(sys.argv[sys.argv.index('--count') + 1])

PRODUCTS = ['薄被', '水洗棉床品四件套', '记忆棉枕头', '儿童隔尿垫', '法兰绒毛毯', '乳胶床垫',
            '沙发套', '窗帘', '厨房防滑垫', '瑜伽垫', '收纳箱', '晾衣架']
MARKETPLACES = ['US', 'CA', 'UK', 'DE', 'JP']
ISSUES = ['退货率偏高', '广告ACOS超标', '库存周转慢', '评论分数下降', 'listing 流量下滑',
          'FBA 入库延迟', '断货风险', '竞品降价']

SHORT_TASKS = [
    '帮我写一封给供应商的催货邮件，语气委婉但明确交期',
    '把这段话翻译成英文，保持商务语气',
    '总结这周会议的三个关键决定',
    '给我5个产品标题的备选，包含核心关键词',
    '这段SQL有语法错误，帮我看看哪里有问题',
    '写一个用来校验邮箱的正则',
    '帮我润色这段周报，让它更简洁',
    '解释一下什么是 FBA 长期仓储费',
    '用一句话解释现金流和利润的区别',
    '帮我把这个列表按优先级排序并说明理由',
    '给新同事写一段入职欢迎词',
    '帮我起10个客服自动回复的模板',
]

MEDIUM_TEMPLATES = [
    '请分析以下产品的销售数据并给出补货建议：{product} 在 {market} 站点近30天日均销量 {n1} 件，'
    '当前 FBA 库存 {n2} 件，在途 {n3} 件，工厂生产周期 {n4} 天，海运时效 45 天。'
    '请考虑旺季备货系数和安全库存，输出建议下单数量和补货节奏，并说明计算过程。',
    '以下是客户差评内容，请归类问题类型（质量/尺寸/物流/描述不符/其他），统计每类数量，'
    '并给出对应的改进措施：{reviews}',
    '我要做 {product} 的 listing 优化。当前标题是 "{title}"，主要关键词有：{kw}。'
    '请给出优化后的标题（200字符内）、五点描述和 A+ 页面内容大纲，注意 {market} 站点买家搜索习惯。',
    '帮我起草一份与货代的年度框架协议要点，涵盖：运价调整机制、旺季舱位保障、破损理赔流程、'
    '账期和对账方式。我们月均出货 {n1} 立方米，主要航线是中国到 {market}。',
    '写一个 Python 脚本处理销售报表：读取 CSV，按 SKU 聚合每周销量，计算4周移动平均和环比，'
    '输出异常波动（超过±{n1}%）的 SKU 清单。要求处理缺失周和重复行。',
    '根据以下邮件往来，整理出每个供应商未决事项、责任人和截止日期，输出表格：{emails}',
]

LONG_DOCS = [
    '合同审查：{contract}',
    '会议纪要整理并提取行动项：{minutes}',
    '竞品分析报告解读，输出差异点和机会点：{report}',
    '以下是我们产品的退货原因原始记录（导出自客服系统），请做根因分析并给出 Top5 问题及占比：{returns}',
    '产品说明书翻译成英文并本地化（美式表达，注意单位换算）：{manual}',
    '请基于以下操作手册生成一份新员工培训大纲和考核要点：{manual}',
]

VERY_LONG = [
    '帮我 review 这段生产环境日志，找出 {n1} 小时内所有 ERROR 及其根因聚类：{logs}',
    '分析这个 SQL 查询慢的原因并给出优化方案，表结构如下：{schema}\n当前执行计划：{plan}',
    '以下是竞品近90天评论数据导出，请做情感分析和主题建模摘要：{reviews}',
    '重构以下代码并补齐单元测试，说明每处改动的理由：{code}',
]

def filler_sentences(n, topic):
    sents = [
        f'{topic}相关的第一点在于执行层面需要明确责任人和时间节点',
        f'其次是数据口径要统一，避免各部门统计标准不一致导致决策偏差',
        f'第三，历史经验表明此类事项平均需要两到三周才能看到初步效果',
        f'另外需要预留约百分之二十的缓冲以应对供应链波动',
        f'同时建议建立周度复盘机制，跟踪关键指标的变化趋势',
        f'从成本角度测算，单件综合成本预计下降空间在0.8到1.5元之间',
        f'包装规格调整后物流体积重量系数也会变化，需要重新核算运费',
        f'客户反馈集中在尺寸偏差和色差两个方面，各占四成左右',
        f'如果旺季前无法完成调整，建议先在新品线试点验证',
        f'最后，所有变更需同步更新到产品资料库并通知相关运营',
    ]
    out = []
    while len(out) < n:
        out.extend(sents)
    return '。'.join(random.sample(out, min(n, len(out))))

def make_medium(i):
    t = random.choice(MEDIUM_TEMPLATES)
    return t.format(
        product=random.choice(PRODUCTS), market=random.choice(MARKETPLACES),
        n1=random.randint(40, 900), n2=random.randint(200, 8000), n3=random.randint(0, 3000),
        n4=random.choice([15, 20, 25, 30]),
        title=f"{random.choice(PRODUCTS)} Soft Breathable All Season Queen Size",
        kw='bedding set, deep pocket, hotel collection, hypoallergenic',
        reviews='；'.join(f'买家{i}-{j}：{random.choice(["尺寸比描述小", "面料起球", "洗后缩水", "颜色与图片不符", "缝线开裂", "物流太慢", "整体满意但包装破损"])}' for j in range(25)),
        emails='；'.join(f'{random.choice(["王经理", "李总", "陈工", "Sarah"])}: {filler_sentences(3, "订单")}' for _ in range(8)),
    )

def make_long(i):
    t = random.choice(LONG_DOCS)
    topic = random.choice(['质量改进', '旺季备货', '渠道拓展', '成本优化', "包装改良"])
    return t.format(
        contract='。'.join(fillers_chunk(topic, 60)),
        minutes='。'.join(fillers_chunk('季度复盘', 55)),
        report='。'.join(fillers_chunk('竞品动向', 70)),
        returns='；'.join(f'退货单{i}-{j}: {random.choice(["尺寸不符", "质量问题", "不想要了", "发货错误", "色差", "包装破损"])}' for j in range(120)),
        manual='。'.join(fillers_chunk('使用说明', 80)),
        logs=' '.join(f'2026-09-{random.randint(10,18)}T{random.randint(0,23):02d}:{random.randint(0,59):02d}:{random.randint(0,59):02d}Z ERROR [{random.choice(["relay", "quota", "db", "auth"])}] upstream failed after {random.randint(2,30000)}ms retry={random.randint(0,3)}' for _ in range(200)),
        schema='CREATE TABLE orders (id BIGINT PRIMARY KEY, sku VARCHAR(64), qty INT, created_at TIMESTAMP, status SMALLINT); CREATE INDEX idx_orders_created ON orders(created_at); -- 数据量约2.1亿行',
        plan='Seq Scan on orders (cost=0.00..9876543.21 rows=12345 width=64) Filter: (created_at > now() - interval \'30 days\')',
        reviews='；'.join(f'review-{j}: {random.choice(["great product", "too small", "love the color", "shipping damage", "excellent quality", "not as described", "would buy again", "cheap material"])}' for j in range(300)),
        code='def process_orders(orders):\n    result = []\n    for o in orders:\n        if o["status"] == 1 and o["qty"] > 0:\n            result.append({"id": o["id"], "total": o["qty"] * o["price"]})\n    return result  # 加上重试、幂等和分批处理',
    )

def fillers_chunk(topic, count):
    return [filler_sentences(1, topic) for _ in range(count)]

def make_very_long(i):
    t = random.choice(VERY_LONG)
    topic = random.choice(['库存对账', '日志治理', '评论运营'])
    return t.format(
        n1=random.choice([1, 2, 6, 24]),
        logs=' '.join(f'ERROR [{random.choice(["relay", "quota", "db", "auth", "timeout"])}] req-{random.randint(100000,999999)} upstream failed after {random.randint(2,30000)}ms retry={random.randint(0,3)} trace={random.getrandbits(48):012x}' for _ in range(600)),
        schema='\n'.join(f'CREATE TABLE t{i} (id BIGINT PRIMARY KEY, payload JSONB, created_at TIMESTAMP); -- {random.randint(1000, 20000)}万行' for i in range(6)),
        plan='Nested Loop Join (cost=1000..8765432 rows=98765) -> Seq Scan on orders -> Index Scan using idx_sku on items',
        reviews='；'.join(f'review-{j}: {random.choice(["great", "too small", "color mismatch", "arrived damaged", "good value", "thin fabric", "perfect fit", "would recommend", "not as pictured", "fast shipping"])}' for j in range(800)),
        code='\n'.join([
            'def sync_inventory(source, target):',
            '    """全量对账脚本, 当前问题: 慢、无幂等、失败重跑会重复写入"""',
            '    for sku, qty in source.all():',
            '        if target.get(sku) != qty:',
            '            target.update(sku, qty)',
            '            notify(f"updated {sku}")',
            '    # 需要: 批量提交、断点续传、冲突检测、监控埋点',
        ] * 20),
    )

lines = []
for i in range(COUNT):
    r = random.random()
    if r < 0.30:
        lines.append(random.choice(SHORT_TASKS))
    elif r < 0.60:
        lines.append(make_medium(i))
    elif r < 0.85:
        lines.append(make_long(i))
    else:
        lines.append(make_very_long(i))

for line in lines:
    # 模板里嵌的多行代码/日志统一压成单行(空格连接)
    line = ' '.join(line.split())
    assert chr(10) not in line
    print(line.strip())
