/** naïve full‑stop insertion: break on “and … .”, long pauses, or 2‑sec gap */
export function repunctuate(lines) {
    const out=[];
    let buf="",start=0,end=0;
    const flush=()=>{ if(buf) out.push({text:buf.trim(),start,end}); buf="";};
    lines.forEach(l=>{
      if(!buf) start=l.start;
      buf+=` ${l.text}`; end=l.end;
      const gap = l.nextGap ?? 0;          // attach nextGap in downloadSubtitles
      if(/[.?!]$/.test(l.text) || gap>2000) flush();
    });
    flush();
    return out;
  }
  