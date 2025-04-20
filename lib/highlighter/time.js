export const hhmmssToMs = t =>
    t.split(/[:,]/).reduce((acc,v,i,a)=> acc+ +v* [3600000,60000,1000,1][i+4-a.length],0);
  
  export const msToHms = ms => {
    const s=Math.max(0,Math.floor(ms/1000));
    const h=String(Math.floor(s/3600)).padStart(2,"0");
    const m=String(Math.floor(s/60)%60).padStart(2,"0");
    const sec=String(s%60).padStart(2,"0");
    return `${h}:${m}:${sec}`;
  };
  