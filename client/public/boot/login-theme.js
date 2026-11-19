// The login page's theme, before first paint (server/auth.js loginPageHtml).
// A file, not inline, for the Content-Security-Policy.
  // Theme, before first paint: the app's stored choice (theme.js, 'shelfit-theme').
  // 'system' or nothing leaves the attribute off and the media query decides.
  (function(){
    var root=document.documentElement,t=null;
    try{t=localStorage.getItem('shelfit-theme');}catch(e){}
    if(t==='light'||t==='dark')root.setAttribute('data-theme',t);
    var light=t==='light'||(t!=='dark'&&window.matchMedia&&window.matchMedia('(prefers-color-scheme: light)').matches);
    var meta=document.querySelector('meta[name="theme-color"]');
    if(meta)meta.setAttribute('content',light?'#f5f5f5':'#0a0a0a');
  })();
