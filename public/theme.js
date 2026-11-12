/* Logged-in user ka email + initial header me dikhata hai (sirf cosmetic). */
(function(){
  function user(){
    try{
      for(var i=0;i<localStorage.length;i++){
        var k=localStorage.key(i);
        if(/^sb-.*-auth-token$/.test(k)){var j=JSON.parse(localStorage.getItem(k));var u=(j&&j.user)||(j&&j.currentSession&&j.currentSession.user);if(u&&u.email)return u.email;}
      }
    }catch(e){}
    return null;
  }
  var tries=0,t=setInterval(function(){
    var e=user(),n=document.querySelector(".username"),a=document.querySelector(".avatar");
    if(e&&n){n.textContent=e.split("@")[0];if(a)a.textContent=e[0].toUpperCase();clearInterval(t);}
    if(++tries>40)clearInterval(t);
  },500);
})();
