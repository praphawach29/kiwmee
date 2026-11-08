// LINE's in-app browser on Android scales every font by the app's own "font size" setting (WebView
// text zoom). CSS cannot turn that off (text-size-adjust does not reach it), so pages in LINE look
// bigger than in Chrome. This runs before the page paints: it measures how much wider text is drawn
// than the same text on a canvas (which the zoom does not touch), and lowers the root font size by the
// same factor. The customer pages size their text in rem, so they come out as designed.
// Only inside LINE: anywhere else the reader's own text size is left alone.
export const TEXT_ZOOM_SCRIPT = `(function(){try{
if(!/\\bLine\\//i.test(navigator.userAgent))return;
var d=document.documentElement,t="MMMMMMMMMM",s=document.createElement("span");
s.style.cssText="position:absolute;left:-9999px;top:0;visibility:hidden;white-space:nowrap;font:100px monospace;";
s.textContent=t;d.appendChild(s);var w=s.getBoundingClientRect().width;d.removeChild(s);
var c=document.createElement("canvas").getContext("2d");if(!c)return;c.font="100px monospace";var m=c.measureText(t).width;
if(!w||!m)return;var z=w/m;
if(z>1.04&&z<4){d.style.fontSize=(16/z).toFixed(3)+"px";d.setAttribute("data-text-zoom",z.toFixed(2));}
}catch(e){}})();`;
