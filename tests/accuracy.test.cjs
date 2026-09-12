const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
require('../transcript.js');
require('../accuracy.js');
const A = globalThis.PanoLearnAccuracy;
const T = globalThis.PanoLearnTranscript;

function fixture(title, setup, method, result, id = 'L1') {
  const lines = ['Today we study ' + title + '.', setup, method, result, 'Now we turn to the next topic.'];
  const lecture = { id, text: lines.map((line, i) => '[' + i + ':00] ' + line).join('\n') };
  const example = { label: title + ' application', note: [setup, method, result].join(' '), start_id: id + ':C2', last_id: id + ':C4', start_quote: setup, last_quote: result, method_quote: method, complete: true };
  const topic = { title, note: 'Study ' + title, start_id: id + ':C1', last_id: id + ':C4', start_quote: lines[0], last_quote: result, complete: true, examples: [example] };
  return { lecture, topic, example };
}

const subjects = [
  ['Calculus', 'Find the derivative of x squared.', 'Apply the power rule and multiply by two.', 'The derivative is two x.'],
  ['Literature', 'Consider the storm in this passage.', 'The repeated darkness links the storm to the narrator’s fear.', 'The image suggests emotional isolation.'],
  ['Clinical reasoning', 'Our case describes fever and a new cough.', 'Compare the symptoms with the test result supplied in this case.', 'The lecturer concludes the case is consistent with the stated diagnosis.'],
  ['Computer science', 'Trace this loop with an empty array.', 'The condition is false so the loop body never executes.', 'The function returns the initial value.'],
  ['법학', '이 사건에서 계약의 성립을 검토합니다.', '청약과 승낙의 시점을 비교해서 요건을 적용합니다.', '이 사례에서는 계약이 성립한다고 결론짓습니다.']
];
for (const subject of subjects) test('preserves source ranges and demonstrated application: ' + subject[0], async () => {
  const { lecture, topic } = fixture(...subject);
  const inventory = await A.collect([lecture], async (system, prompt) => {
    assert.ok(system.includes('ANY subject'));
    assert.ok(prompt.includes(subject[2]));
    return JSON.stringify({ topics: [topic] });
  }, () => {});
  const result = T.groundReferences(A.reconcile({ summary: { main_topics: [{ id: 'T1', title: subject[0], explanation: 'Polished explanation' }], worked_examples: [] } }, inventory), [lecture]);
  assert.equal(result.summary.main_topics[0].explanation, 'Polished explanation');
  assert.equal(result.summary.main_topics[0].references.length, 1);
  assert.equal(result.summary.main_topics[0].references[0].segment, '0:00 ~ 4:00');
  assert.equal(result.summary.worked_examples[0].segment, '1:00 ~ 4:00');
  assert.equal(result.summary.worked_examples[0].topic_id, 'T1');
  assert.ok(result.summary.worked_examples[0].note.includes(subject[2]));
});

test('rejects wrong lecture, reversed boundaries, false quotes and unsupported methods', () => {
  const { lecture, example } = fixture(...subjects[0]);
  const source = A.units(lecture);
  for (const patch of [
    { start_id: 'L2:C2' }, { start_quote: example.last_quote, last_quote: example.start_quote },
    { start_id: 'L1:C999', start_quote: 'Invented source text' },
    { last_id: 'L1:C999', last_quote: 'Invented conclusion' }
  ]) assert.equal(A.evidence({ ...example, ...patch }, source, lecture.id, true), null);
});

test('retains subtitle end time and fractional Panopto times without rounding the underlying seek', () => {
  assert.equal(T.normalize('[{"Caption":"Opening","Time":1.25}]'), '[0:01.25] Opening');
  const lecture = { id: 'L1', text: '00:00:01.250 --> 00:00:04.750\nApply the rule and conclude.' };
  const ref = A.evidence({ note: 'Rule', title: 'Rule', start_id: 'L1:C1', last_id: 'L1:C1', start_quote: 'Apply the rule', last_quote: 'and conclude.', complete: true }, A.units(lecture), lecture.id);
  const result = T.groundReferences({ summary: { main_topics: [{ references: [ref] }] } }, [lecture]);
  assert.equal(result.summary.main_topics[0].references[0].start_seconds, 1.25);
  assert.equal(result.summary.main_topics[0].references[0].end_seconds, 4.75);
});

test('keeps incomplete and visually dependent examples without inventing a last-caption duration', async () => {
  const { lecture, topic } = fixture(...subjects[0]);
  lecture.text = lecture.text.split('\n').slice(0, 4).join('\n');
  topic.examples[0].complete = false;
  topic.examples[0].note = 'The professor applies the power rule. The remaining equation is only shown visually.';
  const inventory = await A.collect([lecture], async () => JSON.stringify({ topics: [topic] }), () => {});
  assert.equal(inventory[0].examples[0].end_seconds, null);
  assert.ok(inventory[0].examples[0].note.includes('only shown visually'));
  assert.equal(inventory[0].examples[0].boundary_status, 'incomplete');
});

test('untimed source supports examples without manufactured seek targets', async () => {
  const lecture = { id: 'L1', text: 'Study a poem. Compare its two images. Their contrast creates tension.' };
  const topic = { title: 'Imagery', note: lecture.text, start_id: 'L1:P1', last_id: 'L1:P1', start_quote: 'Study a poem.', last_quote: 'Their contrast creates tension.', complete: true, examples: [
    { label: 'Image comparison', note: lecture.text, start_id: 'L1:P1', last_id: 'L1:P1', start_quote: 'Study a poem.', last_quote: 'Their contrast creates tension.', method_quote: 'Compare its two images.', complete: true }
  ] };
  const inventory = await A.collect([lecture], async () => JSON.stringify({ topics: [topic] }), () => {});
  assert.equal(inventory[0].examples[0].start_seconds, null);
  assert.equal(inventory[0].examples[0].cue_id, undefined);
});

test('overlapping windows retain every complete cue, original ID and lecture tail', () => {
  const source = Array.from({ length: 80 }, (_, i) => ({ id: 'L1:C' + (i + 1), start: i, text: 'Original cue ' + i + ' ' + 'x'.repeat(800) }));
  const windows = A.windows(source);
  const ids = new Set(windows.flat().map(cue => cue.id));
  assert.equal(ids.size, source.length);
  assert.equal(windows.at(-1).at(-1).id, 'L1:C80');
  assert.ok(windows[0].some(cue => windows[1].includes(cue)));
  assert.ok(windows.every(window => window.reduce((n, cue) => n + cue.text.length + 40, 0) <= 36000));
});

test('keeps same-named examples from different lectures with their correct topic and local times', async () => {
  const first = fixture(...subjects[0], 'L1'), second = fixture(...subjects[0], 'L2');
  const inventory = await A.collect([first.lecture, second.lecture], async (_, prompt) => JSON.stringify({ topics: [prompt.startsWith('Lecture L1') ? first.topic : second.topic] }), () => {});
  const result = A.reconcile({ summary: {} }, inventory);
  assert.equal(result.summary.worked_examples.length, 2);
  assert.deepEqual(result.summary.worked_examples.map(e => [e.topic_id, e.lecture_id]), [['T1', 'L1'], ['T2', 'L2']]);
});

test('invalid extraction and provider failures surface instead of silently deleting examples', async () => {
  const { lecture, topic } = fixture(...subjects[0]);
  await assert.rejects(A.collect([lecture], async () => '{"summary":{}}', () => {}), /invalid response/);
  topic.examples[0].method_quote = 'Not in the transcript';
  const inventory = await A.collect([lecture], async () => JSON.stringify({ topics: [topic] }), () => {});
  assert.equal(inventory[0].examples.length, 1);
  assert.equal(inventory[0].examples[0].content_status, 'unconfirmed');
  assert.equal(inventory[0].examples[0].start_seconds, 60);
  await assert.rejects(A.collect([lecture], async () => { throw new Error('API unavailable'); }, () => {}), /API unavailable/);
});

test('real generation integration restores omitted examples and ignores invented writer ranges', async () => {
  const { lecture, topic } = fixture(...subjects[0]);
  const requests = [];
  const context = vm.createContext({
    window: { location: { href: 'https://school.panopto.com/?id=lecture' } },
    document: { body: {}, readyState: 'loading', addEventListener() {}, getElementById: () => ({}), querySelectorAll: () => [] },
    MutationObserver: class { observe() {} },
    chrome: { runtime: { onMessage: { addListener() {} }, sendMessage: async request => {
      if (request.type !== 'PL_OPENAI') return;
      requests.push(request);
      if (request.system.startsWith('Extract a lecture evidence inventory')) return { text: JSON.stringify({ topics: [topic] }) };
      return { text: JSON.stringify({ summary: { main_topics: [{ id: 'T1', title: 'Calculus', explanation: 'The derivative measures rate of change.', references: [{ cue_id: 'L1:C999' }] }], worked_examples: [] } }) };
    } } }
  });
  for (const file of ['transcript.js', 'accuracy.js']) vm.runInContext(read(file), context);
  vm.runInContext(read('content.js').replace(/\}\)\(\);\s*$/, 'globalThis.generate = callOpenAIAPI;})();'), context);
  const result = await context.generate(lecture.text, ['summary']);
  assert.equal(requests.length, 2);
  assert.ok(requests[1].prompt.includes('Source evidence inventory'));
  assert.equal(result.summary.main_topics[0].references[0].segment, '0:00 ~ 4:00');
  assert.equal(result.summary.worked_examples.length, 1);
  assert.equal(result.summary.worked_examples[0].segment, '1:00 ~ 4:00');
  assert.equal(result.summary.worked_examples[0].topic_id, result.summary.main_topics[0].id);
});

test('retries invalid source evidence once with original context and restores the example', async () => {
  const { lecture, topic } = fixture(...subjects[1]);
  let calls = 0;
  const inventory = await A.collect([lecture], async (_, prompt) => {
    calls++;
    if (calls === 1) return '{"topics":null}';
    assert.ok(prompt.includes('could not be validated'));
    assert.ok(prompt.includes(topic.examples[0].method_quote));
    return JSON.stringify({ topics: [topic] });
  }, () => {});
  assert.equal(calls, 2);
  assert.equal(inventory[0].examples.length, 1);
});

test('coalesces overlapping topic reads without losing separate same-named examples', async () => {
  const lecture = { id: 'L1', text: Array.from({ length: 60 }, (_, i) => '[' + i + ':00] ' + 'Source passage ' + i + '. ' + 'x'.repeat(1000)).join('\n') };
  const source = A.units(lecture);
  const inventory = await A.collect([lecture], async (_, prompt) => {
    const ids = [...prompt.matchAll(/\[(L1:C\d+)\]/g)].map(match => match[1]);
    const first = source.find(unit => unit.id === ids[0]), last = source.find(unit => unit.id === ids.at(-1));
    const index = ids.length > 2 ? 1 : 0;
    const exampleCue = source.find(unit => unit.id === ids[index]);
    const topic = { title: 'One extended explanation', note: first.text.slice(0, 30), start_id: first.id, last_id: last.id, start_quote: first.text.slice(0, 30), last_quote: last.text.slice(0, 30), complete: false, examples: [
      { label: 'Repeated case title', note: exampleCue.text.slice(0, 30), start_id: exampleCue.id, last_id: exampleCue.id, start_quote: exampleCue.text.slice(0, 30), last_quote: exampleCue.text.slice(0, 30), method_quote: exampleCue.text.slice(0, 30), complete: true }
    ] };
    return JSON.stringify({ topics: [topic] });
  }, () => {});
  assert.equal(inventory.length, 1);
  assert.equal(inventory[0].references[0].evidence_start_id, 'L1:C1');
  assert.equal(inventory[0].references[0].evidence_last_id, 'L1:C60');
  assert.ok(inventory[0].examples.length > 1);
  assert.ok(inventory[0].examples.every(example => example.topic_id === 'T1'));
});

test('accuracy requests are bounded to three concurrent calls and preserve lecture order', async () => {
  const fixtures = Array.from({ length: 5 }, (_, i) => fixture(...subjects[0], 'L' + (i + 1)));
  let active = 0, peak = 0;
  const inventory = await A.collect(fixtures.map(f => f.lecture), async (_, prompt) => {
    active++; peak = Math.max(peak, active);
    const source = fixtures.find(f => prompt.startsWith('Lecture ' + f.lecture.id + '\n'));
    await new Promise(resolve => setTimeout(resolve, source.lecture.id === 'L1' ? 10 : 1));
    active--;
    return JSON.stringify({ topics: [source.topic] });
  }, () => {});
  assert.equal(peak, 3);
  assert.equal(active, 0);
  assert.deepEqual(inventory.map(topic => topic.references[0].lecture_id), ['L1', 'L2', 'L3', 'L4', 'L5']);
});

test('unmatched topic evidence does not abort the summary or remove matched examples', async () => {
  const { lecture, topic } = fixture(...subjects[0]);
  topic.start_quote = 'A paraphrase that is not an exact quote';
  let requests = 0;
  const inventory = await A.collect([lecture], async () => {
    requests++;
    return JSON.stringify({ topics: [topic] });
  }, () => {});
  const result = T.groundReferences(A.reconcile({ summary: {} }, inventory), [lecture]);
  assert.equal(requests, 1);
  assert.equal(result.summary.main_topics.length, 1);
  assert.equal(result.summary.main_topics[0].references[0].segment, '0:00 ~ 4:00');
  assert.equal(result.summary.worked_examples[0].segment, '1:00 ~ 4:00');
  assert.equal(result.summary.main_topics[0].references[0].boundary_status, 'cue_anchored');
});

test('recovers punctuation differences, bracketed IDs and unique quotes despite incorrect IDs', () => {
  const { lecture, example } = fixture(...subjects[0]);
  const recovered = A.evidence({ ...example, start_id: 'L1:C999', last_id: '[L1:C4]', start_quote: 'FIND THE DERIVATIVE OF X SQUARED!' }, A.units(lecture), lecture.id, true);
  assert.equal(recovered.start_seconds, 60);
  assert.equal(recovered.end_seconds, 240);
});

test('matches opening and closing quotes split across caption rows', () => {
  const lecture = { id: 'L1', text: '[0:00] Find the derivative\n[0:03] of x squared.\n[0:06] Apply the power rule.\n[0:09] The derivative\n[0:12] is two x.\n[0:15] Next topic.' };
  const ref = A.evidence({ label: 'Derivative', note: 'Apply the power rule.', start_id: 'L1:C2', last_id: 'L1:C4', start_quote: 'Find the derivative of x squared.', last_quote: 'The derivative is two x.', method_quote: 'Apply the power rule.', complete: true }, A.units(lecture), 'L1', true);
  assert.equal(ref.start_seconds, 0);
  assert.equal(ref.end_seconds, 15);
});

test('missing optional examples array is an empty list, not a fatal evidence error', async () => {
  const { lecture, topic } = fixture(...subjects[1]);
  delete topic.examples;
  const inventory = await A.collect([lecture], async () => JSON.stringify({ topics: [topic] }), () => {});
  assert.equal(inventory.length, 1);
  assert.deepEqual(inventory[0].examples, []);
});

test('unconfirmed example cannot regain a timestamp through legacy grounding', () => {
  const { lecture } = fixture(...subjects[0]);
  const result = T.groundReferences({ summary: { worked_examples: [{ boundary_status: 'unconfirmed', cue_id: 'L1:C2', source_quote: 'Find the derivative of x squared.', start_seconds: 60 }] } }, [lecture]);
  assert.equal(result.summary.worked_examples[0].start_seconds, null);
  assert.equal(result.summary.worked_examples[0].segment, 'Timing not confirmed');
});

test('quote recovery preserves mathematical operators and refuses bracketed foreign IDs', () => {
  const lecture = { id: 'L1', text: '[0:00] Compute x + y for this case.\n[0:05] The sum equals three.\n[0:10] Next topic.' };
  const record = { title: 'Sum', note: 'Addition', start_id: 'L1:C1', last_id: 'L1:C2', start_quote: 'Compute x - y for this case.', last_quote: 'The sum equals three.', complete: true };
  const anchored = A.evidence(record, A.units(lecture), 'L1');
  assert.equal(anchored.boundary_status, 'cue_anchored');
  assert.equal(anchored.content_status, 'unconfirmed');
  assert.equal(A.evidence({ ...record, start_id: '[L2:C1]', start_quote: 'Compute x + y for this case.' }, A.units(lecture), 'L1'), null);
});

test('valid caption IDs preserve topic and example ranges when all evidence quotes are paraphrased', async () => {
  const { lecture, topic } = fixture(...subjects[0]);
  for (const record of [topic, ...topic.examples]) {
    record.start_quote = 'Opening paraphrase';
    record.last_quote = 'Closing paraphrase';
    record.method_quote = 'Method paraphrase';
  }
  let calls = 0;
  const inventory = await A.collect([lecture], async () => { calls++; return JSON.stringify({ topics: [topic] }); }, () => {});
  const result = T.groundReferences(A.reconcile({ summary: {} }, inventory), [lecture]);
  assert.equal(calls, 1);
  assert.equal(result.summary.main_topics[0].references[0].segment, '0:00 ~ 4:00');
  assert.equal(result.summary.worked_examples[0].segment, '1:00 ~ 4:00');
  assert.equal(result.summary.worked_examples[0].content_status, 'unconfirmed');
});

test('missing IDs get a targeted source-only repair without rewriting the topic or example', async () => {
  const { lecture, topic } = fixture(...subjects[1]);
  const original = topic.examples[0].note;
  for (const record of [topic, ...topic.examples]) {
    record.start_id = ''; record.last_id = '';
    record.start_quote = ''; record.last_quote = '';
  }
  const formats = [];
  const inventory = await A.collect([lecture], async (_, prompt, format) => {
    formats.push(format);
    if (format === 'inventory') return JSON.stringify({ topics: [topic] });
    assert.ok(prompt.includes('[L1:C5]'));
    return JSON.stringify({ ranges: [
      { id: 'R1', start_id: 'L1:C1', last_id: 'L1:C4' },
      { id: 'R2', start_id: 'L1:C2', last_id: 'L1:C4' }
    ] });
  }, () => {});
  const result = T.groundReferences(A.reconcile({ summary: {} }, inventory), [lecture]);
  assert.deepEqual(formats, ['inventory', 'timing']);
  assert.equal(result.summary.main_topics[0].references[0].segment, '0:00 ~ 4:00');
  assert.equal(result.summary.main_topics[0].explanation, topic.note);
  assert.equal(result.summary.worked_examples[0].segment, '1:00 ~ 4:00');
  assert.equal(result.summary.worked_examples[0].note, original);
});

test('recovery rejects invented, reversed and foreign ranges and preserves notes on failure', async () => {
  for (const repair of [
    { start_id: 'L1:C999', last_id: 'L1:C999' },
    { start_id: 'L2:C1', last_id: 'L2:C4' },
    { start_id: 'L1:C4', last_id: 'L1:C1' }, null
  ]) {
    const { lecture, topic } = fixture(...subjects[0]);
    topic.start_id = ''; topic.last_id = ''; topic.start_quote = ''; topic.last_quote = '';
    const inventory = await A.collect([lecture], async (_, __, format) => {
      if (format === 'inventory') return JSON.stringify({ topics: [topic] });
      if (!repair) throw new Error('Recovery unavailable');
      return JSON.stringify({ ranges: [{ id: 'R1', ...repair }] });
    }, () => {});
    assert.equal(inventory[0].references[0].start_seconds, null);
    assert.equal(inventory[0].examples[0].start_seconds, 60);
  }
});
