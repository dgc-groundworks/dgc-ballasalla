// Silverdale Canvassing: lay an Isle of Man address out the way Royal Mail / Isle of Man Post want it (Ash, 8 Oct 2026).
// The planning register gives one run-on string ("4 High Street Port St Mary Isle Of Man IM9 5DR"). A letter or envelope
// needs it stacked, one part per line, ending with the island and the postcode on their own lines:
//     4 High Street
//     Port St Mary
//     Isle of Man
//     IM9 5DR
// stackLines() takes the recipient lines (name first) and returns them stacked. It is safe to run on lines that are
// already stacked (it changes nothing), so it is applied whenever a letter or envelope is drawn.

const IM_PC_RE = /\bIM\s?\d{1,2}\s?\d[A-Z]{2}\b/i;
const IM_PC_END = /\s*\b([I1]M\s?\d{1,2})\s?(\d[A-Z]{2})\s*$/i;
// Towns and villages, longest first so "Port St Mary" wins over "Mary". "St." is treated as "St".
const IOM_PLACES = ['Port St Mary', 'Kirk Michael', 'Glen Vine', 'Union Mills', 'Port Erin', 'Port Soderick', 'Glen Maye', 'Glen Mona', 'Glen Auldyn',
  'St Johns', "St John's", 'Douglas', 'Onchan', 'Ramsey', 'Peel', 'Castletown', 'Laxey', 'Ballasalla', 'Colby', 'Santon', 'Andreas', 'Sulby', 'Ballaugh',
  'Baldrine', 'Crosby', 'Jurby', 'Foxdale', 'Bride', 'Greeba', 'Braddan', 'Dalby', 'Ballabeg', 'Strang', 'Cregneash', 'Maughold', 'Lonan', 'Garth',
  'Cornaa', 'Ballacraine', 'Lezayre', 'Patrick', 'Surby', 'Kewaigue', 'Newtown', 'Michael', 'Arbory', 'Malew', 'Marown', 'Cronkbourne', 'Bishopscourt',
  'Sandygate', 'Smeale', 'Braaid', 'Abbeylands', 'Eairy', 'St Judes', 'Churchtown', 'Derbyhaven', 'West Baldwin', 'East Baldwin', 'Baldwin', 'Tromode', 'Glen Helen', 'German', 'Mount Rule', 'Rushen', 'Jurby West', 'Stuggadhoo', 'Andreas Village', 'Ballamodha', 'Kerrowmoar', 'Sartfield', 'Cooil', 'Port Grenaugh', 'Poortown', 'Ballavarvane', 'Lhen', 'Close Leece', 'Patrick Village', 'Jurby East', 'Agneash', 'Dogmills', 'Glen Duff', 'Regaby', 'St Marks', 'Glen Roy', 'Ballaragh', 'Injebreck', 'Crosby Village', 'Ballakillowey', 'Balthane', 'Ballaterson', 'Kirkmichael', 'Ballagarraghyn', 'Glenfaba', 'Ballaquine', 'Ballakilley']
  .sort((a, b) => b.split(' ').length - a.split(' ').length || b.length - a.length);
const IOM_TOWNS = new Set(['Douglas', 'Onchan', 'Ramsey', 'Peel', 'Castletown', 'Laxey', 'Ballasalla', 'Colby', 'Port Erin', 'Port St Mary', 'Kirk Michael', 'St Johns', "St John's",
  'Santon', 'Andreas', 'Sulby', 'Ballaugh', 'Baldrine', 'Crosby', 'Jurby', 'Foxdale', 'Bride', 'Union Mills', 'Glen Vine', 'Port Soderick', 'Glen Maye', 'Greeba', 'Braddan', 'Dalby', 'Maughold', 'Lonan', 'Cregneash', 'Patrick']);
const STREET_TYPE = /^(road|rd|street|avenue|ave|drive|lane|hill|close|crescent|terrace|park|way|court|gardens|grove|place|square|walk|row|quay|brow|rise|view|green|mount|villas|estate|promenade|parade|brae|hollow|bank|cottages|mews|circle|roundabout|pier|esplanade|strand|bay)$/i;
const HOUSE_WORD = /^(house|cottage|cottages|farm|lodge|barn|villa|manor|hall|chapel|church|mill|studio|bungalow|centre|building|buildings|works|stables|croft|apartments|flats)$/i;
const STREET_PREFIX = /^(old|new|upper|lower|mount|glen|bay|church|station|north|south|east|west|great|little|back|top|saint|st|main|high|low|market|castle|victoria|prospect|park|queen|queens|kings|king)$/i;
const NO_NUMBER_AFTER = /^(flat|unit|units|plot|apartment|apt|field|fields|no|room|suite)$/i;

const fmtPostcode = s => { const m = String(s).replace(/\s+/g, '').match(/^([I1]M\d{1,2})(\d[A-Z]{2})$/i); return m ? ('IM' + m[1].slice(2) + ' ' + m[2]).toUpperCase() : String(s).trim(); };
const isNumTok = t => /^\d{1,4}[a-z]?(-\d{1,4}[a-z]?)?$/i.test(t) || /^\d{1,4}$/.test(t);

// One run-on string -> lines. Returns the lines, with "Isle of Man" and the postcode last.
function stackAddressText(text){
  let t = String(text || '').replace(/\s+/g, ' ').trim();
  if (!t) return [];
  let pc = '';
  const pm = t.match(IM_PC_END);
  if (pm) { pc = fmtPostcode(pm[1] + pm[2]); t = t.slice(0, pm.index).trim(); }
  t = t.replace(/[,\s]*\bisle of man\b[,\s]*$/i, '').trim().replace(/\bSt\.\s/g, 'St ').replace(/,+\s*$/, '');
  // Commas already separate the parts: respect them.
  const hasCommas = t.includes(',');
  let lines;
  if (hasCommas) {
    lines = t.split(',').map(s => s.trim()).filter(Boolean);
  } else {
    const toks = t.split(' ');
    // trailing town (and locality before it)
    const lower = toks.map(x => x.toLowerCase());
    const endPlace = from => {
      for (const p of IOM_PLACES) {
        const pt = p.toLowerCase().split(' ');
        if (from - pt.length < 0) continue;
        if (pt.every((w, i) => lower[from - pt.length + i] === w)) return { name: p, n: pt.length };
      }
      return null;
    };
    let end = toks.length;
    const places = [];
    for (let k = 0; k < 2; k++) {
      const hit = endPlace(end);
      if (!hit || end - hit.n < 1) break;                 // keep at least one word for the street/house
      places.unshift(hit.name); end -= hit.n;
    }
    // "Douglas Douglas" -> one; if only a locality was matched at the end, it is the town only when it is a real town
    const dedup = places.filter((p, i) => i === 0 || p.toLowerCase() !== places[i - 1].toLowerCase());
    let town = '', locality = '';
    if (dedup.length === 2) { locality = dedup[0]; town = dedup[1]; }
    else if (dedup.length === 1) { town = dedup[0]; }
    const head = toks.slice(0, end);
    lines = splitStreet(head);
    if (locality) lines.push(locality);
    if (town) lines.push(town);
    if (!town && !locality && head.length === toks.length) lines = [t];   // nothing recognised: leave as one line
  }
  const out = lines.map(l => l.replace(/\bSt\.\s/g, 'St '));
  out.push('Isle of Man');
  if (pc) out.push(pc);
  return out;
}

// The part before the town: building name(s), house number and street, each on its own line when we are confident.
function splitStreet(head){
  if (!head.length) return [];
  let t = -1;
  for (let i = head.length - 1; i >= 0; i--) if (STREET_TYPE.test(head[i].replace(/[.,]$/, ''))) { t = i; break; }
  if (t < 0) return [head.join(' ')];
  const before = head.slice(0, t + 1), after = head.slice(t + 1);   // after: anything past the street type (rare)
  // 1) a house number shortly before the street type: "4 High Street", "27 - 31 Strand Street"
  for (let i = 0; i < t; i++) {
    const tok = before[i];
    if (!isNumTok(tok) && !(tok === '-' && i > 0 && isNumTok(before[i - 1]))) continue;
    if (i > 0 && NO_NUMBER_AFTER.test(before[i - 1])) continue;
    // "Flat 1 23 Woodbourne Road": the 1 belongs to the flat, the 23 starts the street
    const flatNo = i > 1 && isNumTok(before[i - 1]) && NO_NUMBER_AFTER.test(before[i - 2]);
    if (i > 0 && !flatNo && (before[i - 1] === '-' || isNumTok(before[i - 1]))) continue;   // inside a range: start at the range's first number
    let s = i;
    if (t - s <= 5) {
      const lead = before.slice(0, s);
      const res = lead.length ? [lead.join(' ')] : [];
      res.push(before.slice(s).join(' '));
      return res.concat(after.length ? [after.join(' ')] : []);
    }
  }
  // 2) a building word followed by the street: "Viking House | Summerhill Road"
  for (let k = 0; k < t - 1; k++) {
    if (HOUSE_WORD.test(before[k])) {
      let e = k; while (e + 1 < t - 1 && HOUSE_WORD.test(before[e + 1])) e++;   // "Farm House"
      return [before.slice(0, e + 1).join(' '), before.slice(e + 1).join(' ')].concat(after.length ? [after.join(' ')] : []);
    }
  }
  // 3) house name + two-word street: "Hazelbank | Minorca Hill"
  if (before.length === 3 && !STREET_PREFIX.test(before[0])) return [before[0], before.slice(1).join(' ')].concat(after.length ? [after.join(' ')] : []);
  // 3b) house name + three-word street that starts with a street word: "Howstrake | King Edward Road"
  if (before.length === 4 && !STREET_PREFIX.test(before[0]) && /^(king|queen|queens|kings|mount|glen|church|station|old|new|upper|lower|north|south|east|west|great|little|st|saint|high|main)$/i.test(before[1])) {
    return [before[0], before.slice(1).join(' ')].concat(after.length ? [after.join(' ')] : []);
  }
  return [before.join(' ')].concat(after.length ? [after.join(' ')] : []);
}

// Recipient lines (name first) -> stacked lines. Idempotent.
function stackLines(lines){
  lines = (lines || []).map(x => String(x == null ? '' : x).trim()).filter(Boolean);
  if (lines.length < 2) return lines;
  const out = [lines[0]];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    const words = line.split(/\s+/).length;
    const runOn = (IM_PC_RE.test(line) && words >= 4) || (/\bisle of man\b/i.test(line) && words >= 5);
    if (runOn) out.push(...stackAddressText(line));
    else if (/^IM\s?\d{1,2}\s?\d[A-Z]{2}$/i.test(line)) out.push(fmtPostcode(line));
    else if (/^isle of man$/i.test(line)) out.push('Isle of Man');
    else out.push(line);
  }
  // Island line before the postcode, once.
  const pcAt = out.findIndex((l, i) => i > 0 && /^IM\d{1,2} \d[A-Z]{2}$/.test(l));
  const dedup = out.filter((l, i) => !(i > 0 && /^isle of man$/i.test(l) && /^isle of man$/i.test(out[i - 1])));
  const at2 = dedup.findIndex((l, i) => i > 0 && /^IM\d{1,2} \d[A-Z]{2}$/.test(l));
  if (at2 > 0 && !/^isle of man$/i.test(dedup[at2 - 1])) dedup.splice(at2, 0, 'Isle of Man');
  void pcAt;
  return dedup;
}
