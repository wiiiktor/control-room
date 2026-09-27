
const IDS = ['clear-detail', 'compose', 'deaf', 'detail', 'fit', 'font-dn', 'font-up', 'form', 'input', 'lamp', 'left', 'pal-btn', 'palette', 'perm-prompt', 'screen', 'splash', 'splash-sess', 'splash-status', 'stage', 'timeline', 'tl-bar', 'tl-btn', 'tl-head', 'to-hint', 'wipe', 'zoomers'], CLASSES = ['empty', 'hint', 'info', 'prompt', 'sess', 'status', 'wrap', 'x'];
class N {
  constructor(tag){ this.tag=tag; this.className=''; this.children=[]; this._t=''; this.style={}; this.dataset={};
    this.hidden=false; this.disabled=false; this.classList={ _s:new Set(),
      add(...c){c.forEach(x=>this._s.add(x))}, remove(...c){c.forEach(x=>this._s.delete(x))},
      toggle(c,f){ f===undefined ? (this._s.has(c)?this._s.delete(c):this._s.add(c)) : (f?this._s.add(c):this._s.delete(c)); return !!f },
      contains(c){return this._s.has(c)} }; }
  get textContent(){ return this._t; } set textContent(v){ this._t=String(v); this.children=[]; }
  append(...n){ n.forEach(x=>this.children.push(x)); }
  replaceChildren(...n){ this.children=n; }
  remove(){}
  setAttribute(){} getAttribute(){return null} removeAttribute(){}
  addEventListener(){} removeEventListener(){}
  querySelector(sel){ const nm=sel.slice(1); return (sel[0]==='#'?IDS:CLASSES).includes(nm) ? new N('div') : null; }
  querySelectorAll(){ return []; }
  get isConnected(){ return true; }
  get clientHeight(){ return 600 } get scrollHeight(){ return 400 } get offsetHeight(){ return 400 }
  getBoundingClientRect(){ return {left:0,top:0,right:0,bottom:0,width:100,height:20} }
  focus(){} blur(){} scrollIntoView(){} setSelectionRange(){}
  get inert(){return false} set inert(v){}
  get value(){return this._v||''} set value(v){this._v=v}
}
const made = {};
const document = {
  documentElement: Object.assign(new N('html'), {dataset:{}}),
  body: new N('body'), head: new N('head'),
  createElement: t => new N(t), createTextNode: t => Object.assign(new N('#text'), {_t:t}),
  getElementById: (id) => IDS.includes(id) ? (made[id] = made[id] || new N('div')) : null,
  querySelector: (sel) => { const nm=sel.slice(1); return (sel[0]==='#'?IDS:CLASSES).includes(nm)? new N('div'):null },
  querySelectorAll: () => [],
  addEventListener(){}, removeEventListener(){},
};
const localStorage = { getItem:()=>null, setItem(){}, removeItem(){} };
const window = { addEventListener(){}, matchMedia:()=>({matches:false,addEventListener(){}}), location:{reload(){}} };
const navigator = { clipboard:{ writeText:async()=>{} } };
globalThis.document = document; globalThis.localStorage = localStorage;
globalThis.window = window; globalThis.navigator = navigator;
globalThis.fetch = async () => ({ ok:true, status:200, json: async () => ({}) });
globalThis.setInterval = () => 0; globalThis.clearInterval = () => {};
globalThis.setTimeout = () => 0; globalThis.requestAnimationFrame = () => 0;
globalThis.acquireVsCodeApi = () => ({ postMessage(){}, setState(){}, getState(){return null} });


try {
