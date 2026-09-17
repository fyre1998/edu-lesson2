'use strict';
// Dependency injection keeps microphone lifecycle testable without live hardware.
function createVoiceInput({transcribe,onText,onState,onError,getContext,mediaDevices=globalThis.navigator?.mediaDevices,Recorder=globalThis.MediaRecorder,Audio=globalThis.AudioContext,clock=globalThis}) {
  let generation=0, recorder=null,stream=null,timer=null,meter=null,analyser=null,audio=null,abort=null,target=null,started=0,peak=0,chunks=[],state='idle';
  function status(next,label){state=next;onState(next,label);}
  function release(){if(timer)clock.clearInterval(timer);timer=null;if(meter)clock.clearInterval(meter);meter=null;stream?.getTracks().forEach(t=>t.stop());stream=null;audio?.close().catch(()=>{});audio=null;analyser=null;}
  function cancel(){generation++;abort?.abort();abort=null;if(recorder?.state==='recording'){recorder.onstop=null;recorder.stop();}recorder=null;release();chunks=[];status('idle','');}
  async function start(field='chat'){
    if(state!=='idle')return;
    const id=++generation,context=getContext();target=field;peak=0;chunks=[];status('requesting','正在申请麦克风…');
    try{
      if(!mediaDevices?.getUserMedia||!Recorder)throw new Error('此浏览器无法录音，请使用 HTTPS 或 localhost，并检查麦克风支持。');
      const incoming=await mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true,autoGainControl:true},video:false});
      if(id!==generation){incoming.getTracks().forEach(t=>t.stop());return;}
      stream=incoming;
      const mime=['audio/webm;codecs=opus','audio/webm','audio/ogg;codecs=opus','audio/mp4'].find(t=>Recorder.isTypeSupported(t));
      if(!mime)throw new Error('浏览器录音格式不兼容，请换用新版 Chrome 或 Edge。');
      recorder=new Recorder(stream,{mimeType:mime});
      if(Audio){audio=new Audio();analyser=audio.createAnalyser();audio.createMediaStreamSource(stream).connect(analyser);const buf=new Uint8Array(analyser.fftSize);meter=clock.setInterval(()=>{if(!analyser)return;analyser.getByteTimeDomainData(buf);for(const x of buf)peak=Math.max(peak,Math.abs(x-128)/128);},100);}
      recorder.ondataavailable=e=>{if(id===generation&&e.data.size)chunks.push(e.data);};
      recorder.onerror=()=>{if(id===generation){cancel();onError('录音中断，请检查麦克风后重试。');}};
      recorder.onstop=async()=>{
        if(id!==generation)return;
        const tooQuiet=!!Audio&&peak<0.008;release();recorder=null;
        const blob=new Blob(chunks,{type:mime});chunks=[];
        if(tooQuiet||blob.size<32){status('idle','');onError('没有检测到清晰声音，请靠近麦克风重新说话。');return;}
        if(blob.size>10*1024*1024){status('idle','');onError('录音超过10 MB，请分段说话。');return;}
        abort=new AbortController();status('transcribing','正在转成文字…');
        try{const text=await transcribe(blob,context,abort.signal);if(id!==generation||context!==getContext())return;if(!text.trim())throw new Error('没有识别到说话内容。');status('sending',field==='chat'?'正在发送…':'正在填入草稿…');await onText(text,field,context);}
        catch(e){if(id===generation&&e.name!=='AbortError')onError(e.message);}
        finally{if(id===generation){abort=null;status('idle','');}}
      };
      recorder.start();started=Date.now();status('recording','录音中 · 0 秒');
      timer=clock.setInterval(()=>{const seconds=Math.floor((Date.now()-started)/1000);status('recording',`录音中 · ${seconds} / 90 秒`);if(seconds>=90)stop();},250);
    }catch(e){if(id!==generation)return;release();status('idle','');onError(e.name==='NotAllowedError'?'麦克风权限未开启，请在浏览器地址栏允许麦克风。':e.name==='NotFoundError'?'没有找到麦克风，请连接麦克风或耳麦。':e.message);}
  }
  function stop(){if(recorder?.state==='recording'){status('stopping','正在结束录音…');recorder.stop();}}
  return {start,stop,cancel,get state(){return state;},get target(){return target;}};
}
if(typeof module!=='undefined')module.exports={createVoiceInput};
