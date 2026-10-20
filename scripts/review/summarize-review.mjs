import fs from 'node:fs';
const raw = fs.readFileSync(process.argv[2], 'utf8');
const obj = JSON.parse(raw).result;
const out = [];
obj.confirmed.forEach((f, i) => {
  out.push(`#${i + 1} [${f.severity_after}${f.severity_after !== f.severity ? ' (was ' + f.severity + ')' : ''}] ${f.title}  — ${f.file.replace(/^.*deploy[\\/]/, '')}:${f.line}  (${f.dimension}, upheld ${f.upheld}/${f.votes})`);
  out.push(`   SCENARIO: ${f.scenario}`);
  out.push(`   FIX: ${f.fix}`);
  const dissent = f.reasons.filter(r => r.startsWith('REFUTED')).map(r => r.slice(0, 400));
  if (dissent.length) out.push(`   DISSENT: ${dissent.join(' || ')}`);
});
out.push(`\nREFUTED (${obj.refuted.length}):`);
obj.refuted.forEach(r => out.push(`- ${r.title} — ${r.file.replace(/^.*deploy[\\/]/, '')}:${r.line} (upheld ${r.upheld}/3)`));
out.push(`coverageGaps: ${JSON.stringify(obj.coverageGaps)} raw=${obj.rawCount}`);
fs.writeFileSync(process.argv[3], out.join('\n'));
console.log(out.join('\n').length, 'chars;', obj.confirmed.length, 'confirmed');
