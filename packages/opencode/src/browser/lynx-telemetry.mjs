/** Generic Node.js adapter. Wrap actual Lynx operations; no provider-specific API. */
export class LynxTelemetry {
  constructor({ sessionId, sessionStartEpochMs, clockAlignment='durations-only', maxSpans=5000 }={}) {
    if(typeof sessionId!=='string'||!sessionId||sessionId.length>100)throw new TypeError('Provide the Lynx Browser Interact sessionId.');
    if(!['session-relative','durations-only'].includes(clockAlignment))throw new TypeError('Invalid clockAlignment.');
    if(clockAlignment==='session-relative'&&!Number.isFinite(sessionStartEpochMs))throw new TypeError('session-relative requires sessionStartEpochMs.');
    if(!Number.isInteger(maxSpans)||maxSpans<1||maxSpans>5000)throw new TypeError('maxSpans must be 1..5000.');
    this.sessionId=sessionId;
    this.clockAlignment=clockAlignment;
    this.origin=performance.now();
    this.offset=clockAlignment==='session-relative'?Date.now()-sessionStartEpochMs:0;
    if(this.offset<0)throw new RangeError('Session start is in the future. Check clock synchronization.');
    this.maxSpans=maxSpans;
    this.spans=[];
    this.sequence=0;
    this.dropped=0;
  }
  now(){return Math.round((this.offset+performance.now()-this.origin)*1000)/1000;}
  async span(meta,operation) {
    if(!meta||!['model','screenshot','observation','action','wait'].includes(meta.phase))throw new TypeError('Invalid phase.');
    if(typeof operation!=='function')throw new TypeError('operation must be a function.');
    const startMs=this.now();
    const id='lynx-span-'+(++this.sequence);
    let status='ok';
    const metrics={};
    const context={id,setMetrics(values){for(const key of ['inputTokens','outputTokens','imageBytes'])if(values?.[key]!==undefined){if(!Number.isFinite(values[key])||values[key]<0)throw new TypeError('Invalid metric: '+key);metrics[key]=values[key];}}};
    try { return await operation(context); }
    catch(error){status='error';throw error;}
    finally {
      const record={id,phase:meta.phase,startMs,endMs:this.now(),status};
      for(const key of ['proof','actionId','operationId'])if(meta[key]!=null)record[key]=String(meta[key]).slice(0,100);
      Object.assign(record,metrics);
      if(this.spans.length<this.maxSpans)this.spans.push(record);else this.dropped++;
    }
  }
  export(){return {format:'lynx-trace-v1',sessionId:this.sessionId,clockAlignment:this.clockAlignment,spans:this.spans.map(s=>({...s})),droppedSpans:this.dropped};}
  toJSON(){return JSON.stringify(this.export(),null,2);}
  async save(filename){const fs=await import('node:fs/promises');await fs.writeFile(filename,this.toJSON(),'utf8');}
}
