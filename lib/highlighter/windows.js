import { hhmmssToMs } from "./time.js";

export function buildWindows(marked){
  const wins=[];
  for(let i=0;i<marked.length;i++){
    if(!marked[i].isQ) continue;
    let j=i+1;
    // stop at next real question OR 3‑min cap
    while(j<marked.length &&
          !marked[j].isQ &&
          marked[j].end-marked[i].start < 180000) j++;
    wins.push({
      idxFrom:i, idxTo:j-1,
      start:marked[i].start,
      end:marked[j-1].end,
      text:marked.slice(i,j).map(s=>s.text).join(" ")
    });
    i=j-1;
  }
  return wins;
}
