import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read=p=>readFileSync(new URL("../"+p,import.meta.url),"utf8");
const web=read("public/index.html");
const native=read("desktop/ui/index.html");
const webCss=read("public/apple-unified.css");
const nativeCss=read("desktop/ui/apple-unified.css");
const nativeApp=read("desktop/ui/app.js");

test("both apps load their shared design system after the original styles",()=>{
  assert.match(web, /dashboard-theme\.css.*?apple-unified\.css/s);
  assert.match(native, /style\.css.*?apple-unified\.css/s);
});
test("desktop and web use exactly the same base design rules",()=>{
  assert.ok(webCss.startsWith(nativeCss),"Web may extend, but not diverge from, native base styles");
  for(const token of ["--mc-green:","--mc-surface:","--mc-ease:","--mc-fast:"]){
    assert.ok(webCss.includes(token)&&nativeCss.includes(token));
  }
});
test("shared controls have primary, danger, hover, pressed and keyboard focus states",()=>{
  for(const css of [webCss,nativeCss]){
    for(const key of [".btn.primary",".btn.danger",":hover:not(:disabled)",":active:not(:disabled)",":focus-visible","prefers-reduced-motion"]){
      assert.ok(css.includes(key),"Missing motion or interaction rule "+key);
    }
  }
});
test("page transitions don't re-trigger on periodic telemetry refresh",()=>{
  assert.ok(web.includes("lastAnimatedTab!==tab"));
  assert.ok(nativeApp.includes("state._lastAnimatedPage!==state.page"));
  assert.ok(webCss.includes(".mc-page-enter"));
  assert.ok(nativeCss.includes(".mc-page-enter"));
});
