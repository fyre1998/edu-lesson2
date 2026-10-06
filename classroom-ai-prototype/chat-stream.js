'use strict';
(function(root){
  async function read(response,onText=()=>{}) {
    if(!response.body?.getReader)throw new Error('浏览器暂不支持流式回复，请更新浏览器后重试');
    const reader=response.body.getReader(),decoder=new TextDecoder();
    let buffer='',event='',data=[];
    function line(value){
      if(value.endsWith('\r'))value=value.slice(0,-1);
      if(value===''){
        const kind=event,raw=data.join('\n');event='';data=[];
        if(!raw)return;
        const payload=JSON.parse(raw);
        if(kind==='text'&&typeof payload.text==='string')onText(payload.text);
        if(kind==='error'){const error=new Error(payload.detail||'AI 回复中断，请重试');error.status=payload.status;throw error;}
        if(kind==='done'){
          if(!payload.id||typeof payload.answer!=='string')throw new Error('AI 回复数据不完整，请重试');
          return payload;
        }
      } else if(value.startsWith('event:'))event=value.slice(6).trim();
      else if(value.startsWith('data:'))data.push(value.slice(5).replace(/^ /,''));
    }
    try {
      while(true){
        const {value,done}=await reader.read();
        buffer+=decoder.decode(value,{stream:!done});
        let end;
        while((end=buffer.indexOf('\n'))>=0){
          const result=line(buffer.slice(0,end));buffer=buffer.slice(end+1);
          if(result)return result;
        }
        if(done)throw new Error('AI 回复连接中断，请重试这条消息');
      }
    } finally {await reader.cancel().catch(()=>{});reader.releaseLock();}
  }
  root.ChatStream={read};
  if(typeof module==='object'&&module.exports)module.exports=root.ChatStream;
})(globalThis);
