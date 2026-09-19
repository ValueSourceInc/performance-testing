import si from 'systeminformation';
let busy = false;
const timer = setInterval(async () => {
  if (busy) return;
  busy = true;
  try {
    const stats = await si.networkStats('*');
    process.send?.({ time: new Date().toISOString(), interfaces: stats.map(n => ({ name:n.iface,
      rxBytes:n.rx_bytes,txBytes:n.tx_bytes,rxBytesPerSecond:n.rx_sec,txBytesPerSecond:n.tx_sec,
      rxErrors:n.rx_errors,txErrors:n.tx_errors,rxDropped:n.rx_dropped,txDropped:n.tx_dropped })) });
  } catch { process.send?.({ time:new Date().toISOString(),error:'Network counters unavailable' }); }
  finally { busy = false; }
},5000);
process.on('disconnect',()=>{clearInterval(timer);process.exit(0)});
process.on('SIGINT',()=>{});
