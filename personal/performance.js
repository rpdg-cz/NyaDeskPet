/* Render-only blending. Never feeds blended values back into Cubism's saved pose. */
(function(root){
  const defaults={continuityVersion:1,resetBeforeTurn:false,transitionMs:450,idleTransitionMs:900};
  function policy(value={}){
    const ms=(n,f)=>Number.isFinite(n)?Math.max(100,Math.min(3000,n)):f;
    return {...defaults,transitionMs:ms(value.transitionMs,450),idleTransitionMs:ms(value.idleTransitionMs,900)};
  }
  class PoseContinuity{
    constructor(){this.states=new Map();}
    clear(){this.states.clear();}
    begin(id,now,duration){
      const state=this.states.get(id);
      if(state?.last)state.blend={from:state.last.slice(),start:now,duration};
    }
    phase(id,phase,now,settings){
      let state=this.states.get(id);
      if(!state){state={phase:null,last:null,blend:null};this.states.set(id,state);}
      if(state.phase===phase)return false;
      state.phase=phase;
      this.begin(id,now,phase==='idle'?settings.idleTransitionMs:settings.transitionMs);
      return true;
    }
    sample(id,values,now){
      let state=this.states.get(id);
      if(!state){state={phase:'idle',last:null,blend:null};this.states.set(id,state);}
      let output=values.slice();
      if(state.blend){
        const b=state.blend,t=Math.min(1,Math.max(0,(now-b.start)/b.duration)),weight=t*t*(3-2*t);
        output=output.map((target,i)=>Number.isFinite(b.from[i])?b.from[i]+(target-b.from[i])*weight:target);
        if(t===1)state.blend=null;
      }
      state.last=output;
      return output;
    }
    read(){return [...this.states].map(([id,s])=>({id,phase:s.phase,blending:Boolean(s.blend)}));}
  }
  const api={policy,PoseContinuity};
  if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.DuoPerformance=api;
})(globalThis);
