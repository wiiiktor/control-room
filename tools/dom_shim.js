
const IDS = ['clear-detail', 'compose', 'deaf', 'detail', 'fit', 'font-dn', 'font-up', 'form', 'input', 'lamp', 'left', 'pal-btn', 'palette', 'perm-prompt', 'screen', 'splash', 'splash-sess', 'splash-status', 'stage', 'timeline', 'tl-bar', 'tl-btn', 'tl-head', 'to-hint', 'wipe', 'zoomers'], CLASSES = ['empty', 'hint', 'info', 'prompt', 'sess', 'status', 'wrap', 'x'];
class N {
  constructor(tag){ this.tag=tag; this.className=''; this.children=[]; this._t=''; this.style={setProperty(k,v){this['_'+k]=v;},getPropertyValue(k){return this['_'+k]||'';},removeProperty(k){delete this['_'+k];}}; this.dataset={};
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
  // \u26d4 A TAG SELECTOR USED TO RETURN NULL, and the page legitimately does
  // `btn.querySelector('span').textContent = ...` on a span it just appended. The real DOM finds it;
  // the shim did not, so the harness reported two bugs that were its own. It now searches the node's
  // OWN children (one level deep, then recursively), which is what the page actually relies on, and
  // still returns null for an element that is genuinely not there -- that null is the bug class this
  // whole harness exists to catch.
  querySelector(sel){
    const hit = (n) => {
      if (sel[0] === '.') return n.classList && n.classList.contains(sel.slice(1));
      if (sel[0] === '#') return false;
      return String(n.tag || '').toLowerCase() === sel.toLowerCase();
    };
    const walk = (n) => {
      for (const k of n.children || []) { if (hit(k)) return k; const d = walk(k); if (d) return d; }
      return null;
    };
    const found = walk(this);
    if (found) return found;
    const nm = sel.slice(1);
    return (sel[0] === '#' ? IDS : CLASSES).includes(nm) ? new N('div') : null;
  }
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
// \u26d4 A STUB THAT RETURNS {} MEANS THE HARNESS NEVER REACHES THE CODE. With no sessions in the
// response the page builds no rows, so there is nothing to click and every click test passes
// vacuously -- proved by reintroducing a temporal-dead-zone bug and watching the harness stay green.
// These fixtures are the smallest shapes that make the page build real rows: two sessions, one
// watching and one not, one of them live elsewhere.
const A_ID = 'aaaaaaaa-1111-2222-3333-444444444444';
const B_ID = 'bbbbbbbb-1111-2222-3333-444444444444';
globalThis.FIXTURES = {
  '/api/sessions': {
    sessions: { [A_ID]: 'the session that is watching', [B_ID]: 'a session that is asleep' },
    watchers: [{ session: A_ID, age: 3, label: 'the session that is watching' }],
    elsewhere: {},
    live: { [B_ID]: { status: 'idle', kind: 'background' } },
    waking: {},
  },
  '/api/log': {
    messages: [{ id: 1, role: 'user', text: 'hello', ts: '2026-09-27T21:00:00', session: A_ID },
               { id: 2, role: 'assistant', text: '::ok hello back', ts: '2026-09-27T21:00:01', session: A_ID }],
    last: 2, build: 'test', status: [], watch: 3, hidden: [],
    watchers: [{ session: A_ID, age: 3, label: 'the session that is watching' }],
    elsewhere: {}, live: { [B_ID]: { status: 'idle', kind: 'background' } }, waking: {},
  },
};
globalThis.fetch = async (url) => {
  const u = String(url);
  const key = Object.keys(globalThis.FIXTURES).find(k => u.indexOf(k) >= 0);
  const body = key ? globalThis.FIXTURES[key] : { ok: true };
  return { ok: true, status: 200, json: async () => body };
};
globalThis.setInterval = () => 0; globalThis.clearInterval = () => {};
globalThis.setTimeout = () => 0; globalThis.requestAnimationFrame = () => 0;
globalThis.acquireVsCodeApi = () => ({ postMessage(){}, setState(){}, getState(){return null} });


try {
