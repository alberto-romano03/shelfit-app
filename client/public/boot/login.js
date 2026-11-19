// The login page (server/auth.js loginPageHtml): profile picker, password,
// invite. A file, not inline, for the Content-Security-Policy; its data comes
// from the page's <script type="application/json" id="login-data">.
  (function(){
    // The page's data, as JSON (not script): the profiles to pick from, and the
    // invite this page was opened with, if any.
    var DATA=JSON.parse(document.getElementById('login-data').textContent);
    var BASE=DATA.base, PROFILES=DATA.profiles, INVITE=DATA.invite;
    // Language: the app's stored choice, else the browser's. Both languages ship
    // in data attributes; fill every translatable node from its own.
    var lang='en';
    try{lang=localStorage.getItem('shelfit:lang');}catch(e){}
    if(lang!=='it'&&lang!=='en')lang=(navigator.language||'').slice(0,2).toLowerCase()==='it'?'it':'en';
    document.documentElement.setAttribute('lang',lang);
    var nodes=document.querySelectorAll('[data-'+lang+']');
    for(var i=0;i<nodes.length;i++)nodes[i].textContent=nodes[i].getAttribute('data-'+lang);
    var phs=document.querySelectorAll('[data-'+lang+'-placeholder]');
    for(var k=0;k<phs.length;k++)phs[k].setAttribute('placeholder',phs[k].getAttribute('data-'+lang+'-placeholder'));

    // Nobody is signed in on this browser now (a session that expired, was ended
    // from another device, or was replaced by another member's sign-in), so it
    // keeps nobody's personal data: every member's device cache and the offline
    // API copies go, as on an explicit sign-out (client/src/userScope.js).
    // Device preferences (language, theme) are not member-scoped and stay.
    try{
      var MEMBER_KEY=/^shelfit:u[0-9]+:/;
      [localStorage,sessionStorage].forEach(function(st){
        // Collect first: key order may change as keys are removed.
        var doomed=[];
        for(var j=0;j<st.length;j++){var key=st.key(j);if(key&&MEMBER_KEY.test(key))doomed.push(key);}
        doomed.forEach(function(key){st.removeItem(key);});
      });
      localStorage.removeItem('shelfit:last-uid');
      if(window.caches)caches.keys().then(function(names){
        names.forEach(function(n){if(n.indexOf('shelfit-data-')===0)caches.delete(n);});
      });
    }catch(e){}

    var picker=document.getElementById('picker'),signin=document.getElementById('signin'),
        list=document.getElementById('profiles'),who=document.getElementById('who'),
        f=document.getElementById('f'),pw=document.getElementById('pw'),uname=document.getElementById('uname'),
        btn=document.getElementById('btn'),back=document.getElementById('back'),err=document.getElementById('err');
    var selected=null;
    function msg(key){return err.getAttribute('data-'+lang+'-'+key)||'';}

    // An avatar circle: the chosen image, else the name's first letter, with the
    // member's badge on its corner when they have one. Names are only ever set
    // as text, never as HTML.
    function avatar(p){
      var wrap=document.createElement('span');
      wrap.className='tile-media';
      wrap.setAttribute('aria-hidden','true');
      var el=document.createElement('span');
      el.className='avatar';
      function initial(){el.textContent=(Array.from(p.name||'?')[0]||'?').toUpperCase();}
      if(p.avatar){
        var img=document.createElement('img');
        img.alt='';img.decoding='async';
        img.onerror=function(){img.remove();initial();};
        img.src=BASE+p.avatar;
        el.appendChild(img);
      }else initial();
      wrap.appendChild(el);
      if(p.badge){
        var badge=document.createElement('span');
        badge.className='badge';
        var bimg=document.createElement('img');
        bimg.alt='';bimg.decoding='async';
        bimg.onerror=function(){badge.remove();};
        bimg.src=BASE+p.badge;
        badge.appendChild(bimg);
        wrap.appendChild(badge);
      }
      return wrap;
    }
    function nameEl(p){
      var n=document.createElement('span');
      n.className='name';n.textContent=p.name;
      return n;
    }

    function showPicker(){
      selected=null;err.textContent='';
      signin.hidden=true;picker.hidden=false;
      var first=list.querySelector('button');
      if(first)first.focus();
    }
    function choose(p){
      selected=p;err.textContent='';pw.value='';
      who.textContent='';who.appendChild(avatar(p));who.appendChild(nameEl(p));
      uname.value=p.name; // lets password managers keep one entry per member
      back.hidden=PROFILES.length<2;
      picker.hidden=true;signin.hidden=false;
      pw.focus();
    }

    PROFILES.forEach(function(p){
      var li=document.createElement('li');
      var b=document.createElement('button');
      b.type='button';b.className='profile';
      b.appendChild(avatar(p));b.appendChild(nameEl(p));
      b.addEventListener('click',function(){choose(p);});
      li.appendChild(b);list.appendChild(li);
    });
    back.addEventListener('click',showPicker);
    document.addEventListener('keydown',function(ev){
      if(ev.key==='Escape'&&!signin.hidden&&PROFILES.length>1)showPicker();
    });

    // An invite link: read the token, then drop it from the address bar so it
    // doesn't linger in history. A valid one opens "choose your password".
    var inviteToken=null;
    if(INVITE){
      try{
        inviteToken=new URLSearchParams(window.location.search).get('invite');
        history.replaceState(null,'',BASE+'/login');
      }catch(e){}
    }
    if(INVITE&&!INVITE.invalid&&inviteToken){
      var inviteView=document.getElementById('invite'),fi=document.getElementById('fi'),
          ipw=document.getElementById('ipw'),ipw2=document.getElementById('ipw2'),
          ibtn=document.getElementById('ibtn'),ierr=document.getElementById('ierr');
      var imsg=function(key){return ierr.getAttribute('data-'+lang+'-'+key)||'';};
      var iwho=document.getElementById('iwho');
      iwho.appendChild(avatar({name:INVITE.name}));iwho.appendChild(nameEl({name:INVITE.name}));
      document.getElementById('iuname').value=INVITE.name;
      inviteView.hidden=false;
      ipw.focus();
      fi.addEventListener('submit',function(ev){
        ev.preventDefault();
        ierr.textContent='';
        if(ipw.value.length<8){ierr.textContent=imsg('short');ipw.focus();return;}
        if(ipw.value!==ipw2.value){ierr.textContent=imsg('mismatch');ipw2.focus();ipw2.select();return;}
        ibtn.disabled=true;
        fetch(BASE+'/api/auth/invite',{
          method:'POST',headers:{'Content-Type':'application/json'},
          body:JSON.stringify({token:inviteToken,password:ipw.value})
        }).then(function(r){
          if(r.ok){window.location.replace(BASE+'/');return;}
          ibtn.disabled=false;
          ierr.textContent = r.status===410 ? imsg('invalid') : r.status===429 ? imsg('limit') : imsg('short');
        }).catch(function(){
          ibtn.disabled=false;ierr.textContent=imsg('network');
        });
      });
      return; // the picker stays hidden while choosing a password
    }
    if(INVITE&&INVITE.invalid)document.getElementById('notice').hidden=false;

    if(PROFILES.length===1&&!(INVITE&&INVITE.invalid))choose(PROFILES[0]);else showPicker();

    // Generic message when arriving from an invalid/expired magic link: never
    // says why (expired vs unknown vs revoked vs rate-limited).
    try{
      if(/[?&]error=/.test(window.location.search)){
        // A single profile is already on its password step; with several, the
        // link could have been anyone's, so the picker says it instead.
        if(signin.hidden){
          var nt=document.getElementById('notice');
          nt.textContent=nt.getAttribute('data-'+lang+'-magic')||'';
          nt.hidden=false;
        }else err.textContent=msg('magic');
        history.replaceState(null,'',BASE+'/login');
      }
    }catch(e){}

    f.addEventListener('submit',function(ev){
      ev.preventDefault();
      if(!selected)return;
      err.textContent='';btn.disabled=true;
      fetch(BASE+'/api/auth/login',{
        method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({user_id:selected.id,password:pw.value})
      }).then(function(r){
        if(r.ok){window.location.replace(BASE+'/');return;}
        btn.disabled=false;
        err.textContent = r.status===429 ? msg('limit') : msg('wrong');
        pw.focus();pw.select();
      }).catch(function(){
        btn.disabled=false;err.textContent=msg('network');
      });
    });
  })();
