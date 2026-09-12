const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const read = name => fs.readFileSync(path.join(__dirname, '..', name), 'utf8');
require('../transcript.js');
const { normalize, chunks } = globalThis.PanoLearnTranscript;
const katex = require('../vendor/katex/katex.min.js');
const tick = () => new Promise(resolve => setImmediate(resolve));

test('manifest starts capture in every frame and creates UI only in the top frame', () => {
  const manifest = JSON.parse(read('manifest.json'));
  const sniffer = manifest.content_scripts.find(s => s.js.includes('sniffer.js'));
  const capture = manifest.content_scripts.find(s => s.js.includes('capture.js'));
  const ui = manifest.content_scripts.find(s => s.js.includes('content.js'));
  assert.equal(sniffer.world, 'MAIN');
  assert.equal(sniffer.all_frames, true);
  assert.equal(sniffer.run_at, 'document_start');
  assert.equal(capture.all_frames, true);
  assert.equal(capture.run_at, 'document_start');
  assert.ok(!ui.all_frames);
});

test('normalizes Panopto JSON, VTT and SRT without losing timestamps or lecture text', () => {
  assert.equal(normalize(JSON.stringify({ d: [{ Caption: 'A &amp; B', Time: 0 }, { Caption: 'Conclusion', Time: 123 }] })), '[0:00] A & B\n[2:03] Conclusion');
  const vtt = normalize('WEBVTT\n\ncue-one\n00:00:01.000 --> 00:00:03.000\n<b>Opening</b>\n\nNOTE hidden\nignore\n\ncue-two\n00:30:00.000 --> 00:30:05.000\nEnding');
  assert.ok(vtt.includes('00:30:00.000'));
  assert.ok(vtt.includes('Opening') && vtt.includes('Ending'));
  assert.ok(!vtt.includes('WEBVTT') && !vtt.includes('cue-one') && !vtt.includes('ignore'));
  assert.equal(normalize('1\n00:00:00,000 --> 00:00:02,000\nHello'), '00:00:00,000 --> 00:00:02,000\nHello');
  assert.equal(normalize('<!doctype html><html>Sign in</html>'), '');
  assert.equal(normalize('{"error":"Forbidden"}'), '');
  assert.equal(normalize('History and literature'), 'History and literature');
});

test('chunking preserves every character including final sections and unbroken text', () => {
  for (const input of ['Intro\n' + 'Subject matter. '.repeat(8000) + '\nFINAL CONCLUSION', '한'.repeat(50000)]) {
    const parts = chunks(input);
    assert.equal(parts.join(''), input);
    assert.ok(parts.every(part => part.length <= 14000));
  }
});

function frameContext() {
  const listeners = [];
  const runtimeListeners = [];
  const messages = [];
  class XHR {
    open() {} send() {}
    addEventListener(type, fn) { this.loaded = fn; }
  }
  const context = vm.createContext({ URL, Request, XMLHttpRequest: XHR,
    location: { href: 'https://school.panopto.com/Panopto/Pages/Viewer.aspx?id=lecture' },
    document: { title: 'History lecture', readyState: 'loading', addEventListener() {} },
    chrome: { runtime: {
      sendMessage: async message => messages.push(message),
      onMessage: { addListener: fn => runtimeListeners.push(fn) }
    } },
    fetch: async () => ({ ok: true, clone: () => ({ text: async () => '{"d":[{"Caption":"Early caption","Time":0}]}' }) })
  });
  context.window = context;
  context.addEventListener = (type, listener) => listeners.push(listener);
  context.postMessage = data => listeners.forEach(listener => listener({ source: vm.runInContext('window', context), data }));
  return { context, messages, runtimeListeners };
}

test('replays a response captured before the isolated bridge loads; supports JSON XHR', async () => {
  const { context, messages, runtimeListeners } = frameContext();
  vm.runInContext(read('sniffer.js'), context);
  await vm.runInContext('fetch("/Panopto/Pages/Viewer/GetCaptions")', context);
  await tick();
  assert.equal(messages.length, 0);
  vm.runInContext(read('transcript.js'), context);
  vm.runInContext(read('capture.js'), context);
  assert.equal(messages.find(m => m.type === 'PL_TRANSCRIPT').text, '[0:00] Early caption');
  vm.runInContext(`const xhr = new XMLHttpRequest(); xhr.open('GET', '/captions'); xhr.send(); xhr.status = 200; xhr.responseType = 'json'; xhr.response = [{Caption:'Late caption',Time:500}]; xhr.loaded();`, context);
  assert.ok(messages.some(m => m.text === '[8:20] Late caption'));
  const count = messages.length;
  runtimeListeners[0]({ type: 'PL_REPLAY' });
  assert.ok(messages.length > count);
  context.location.href = 'https://school.panopto.com/new-lecture';
  const beforeNavigationReplay = messages.length;
  runtimeListeners[0]({ type: 'PL_REPLAY' });
  assert.equal(messages.length, beforeNavigationReplay + 1);
  assert.equal(messages.at(-1).type, 'PL_FRAME_READY');
});

function backgroundContext(fetchImpl) {
  let listener;
  const relays = [];
  const context = vm.createContext({ URL, AbortSignal, TextDecoder, fetch: fetchImpl,
    chrome: { runtime: { id: 'extension', getURL: path => 'chrome-extension://extension/' + path, onMessage: { addListener: fn => { listener = fn; } } },
      tabs: { sendMessage: async (...args) => relays.push(args) },
      action: { setBadgeText() {}, setBadgeBackgroundColor() {} },
      storage: { local: { remove: async () => {} }, session: { get: async () => ({ plAccount: { token: 'google-test-token', expiresAt: Date.now() + 3600000 } }), remove: async () => {} } }
    }
  });
  context.importScripts = (...files) => files.forEach(file => vm.runInContext(read(file), context));
  vm.runInContext(read('background.js'), context);
  context.PANOLEARN_SERVICE = { apiBaseUrl: 'https://service.example', googleClientId: 'client-test' };
  return { context, relays, listener };
}

test('worker routes iframe transcripts to frame zero in the same tab and replays to all frames', async () => {
  const { listener, relays } = backgroundContext();
  listener({ type: 'PL_TRANSCRIPT', text: 'Lecture', key: 'source' }, { id: 'extension', tab: { id: 7 }, frameId: 9, documentId: 'doc' });
  assert.equal(relays[0][0], 7);
  assert.equal(relays[0][2].frameId, 0);
  assert.equal(relays[0][1].frameId, 9);
  assert.equal(relays[0][1].text, 'Lecture');
  listener({ type: 'PL_REQUEST_CAPTURES' }, { id: 'extension', tab: { id: 7 }, frameId: 0 });
  assert.equal(relays[1][1].type, 'PL_REPLAY');
  assert.equal(relays[1].length, 2);
  listener({ type: 'PL_TRANSCRIPT', text: 'Bad' }, { id: 'other', tab: { id: 7 }, frameId: 2 });
  assert.equal(relays.length, 2);
});

function stream(events) {
  const bytes = new TextEncoder().encode(events.map(event => 'data: ' + JSON.stringify(event) + '\n\n').join(''));
  return { ok: true, body: new ReadableStream({ start(controller) {
    for (let offset = 0; offset < bytes.length; offset += 7) controller.enqueue(bytes.slice(offset, offset + 7));
    controller.close();
  } }) };
}

test('API proxy assembles split streaming events and reports truncation, interruption and errors', async () => {
  const deltas = [{ type: 'response.output_text.delta', delta: '안녕하세요' }];
  let body;
  const { context } = backgroundContext(async (url, options) => {
    assert.equal(url, 'https://service.example/v1/study');
    assert.equal(options.headers.Authorization, 'Bearer google-test-token');
    body = JSON.parse(options.body);
    return stream([...deltas, { type: 'response.completed', response: { status: 'completed' } }]);
  });
  assert.equal(await context.callOpenAI({ system: 'Study', prompt: 'History' }), '안녕하세요');
  assert.equal(body.system, 'Study');
  assert.equal(body.prompt, 'History');
  assert.equal(body.model, undefined);
  assert.equal(body.max_output_tokens, undefined);
  context.fetch = async () => stream([...deltas, { type: 'response.incomplete', response: { incomplete_details: { reason: 'max_output_tokens' } } }]);
  await assert.rejects(context.callOpenAI({ system: 'Study', prompt: 'History' }), /too long/);
  context.fetch = async () => stream(deltas);
  await assert.rejects(context.callOpenAI({ system: 'Study', prompt: 'History' }), /interrupted/);
  context.fetch = async () => stream([{ type: 'error', message: 'Overloaded' }]);
  await assert.rejects(context.callOpenAI({ system: 'Study', prompt: 'History' }), /Overloaded/);
});

function generationContext() {
  const requests = [];
  const context = vm.createContext({
    window: { location: { href: 'https://school.instructure.com/courses/1' } },
    document: { body: {}, readyState: 'loading', addEventListener() {}, getElementById: () => ({}), querySelectorAll: () => [] },
    MutationObserver: class { observe() {} },
    chrome: { runtime: { onMessage: { addListener() {} }, sendMessage: async request => {
      if (request.type !== 'PL_OPENAI') return;
      requests.push(request);
      if (request.system.includes('Required JSON structure')) return { text: '{"scope_note":"Full source processed","summary":{"tldr":"Literature summary"}}' };
      return { text: 'Preserved: ' + request.prompt.slice(-100) };
    } } }
  });
  vm.runInContext(read('transcript.js'), context);
  // These legacy tests isolate summarization/capture from source extraction.
  // The real accuracy pipeline is exercised separately in accuracy.test.cjs.
  context.PanoLearnAccuracy = { collect: async () => null, reconcile: value => value };
  // Expose the closure only in the test context; production has no test hooks.
  vm.runInContext(read('content.js').replace(/\}\)\(\);\s*$/, 'globalThis.generate = callOpenAIAPI; globalThis.validate = validateResult; globalThis.markdown = resultToMarkdown;})();'), context);
  return { context, requests };
}

test('long lecture generation processes every part with automatic subject-appropriate detail', async () => {
  const { context, requests } = generationContext();
  const transcript = 'Literature, culture and interpretation. '.repeat(4000) + 'FINAL IMPORTANT CONCLUSION';
  const result = await context.generate(transcript, ['summary']);
  const partRequests = requests.slice(0, -1);
  assert.equal(partRequests.length, chunks(transcript, 60000).length);
  assert.equal(partRequests.map(r => r.prompt.replace(/^Part \d+\/\d+\n/, '')).join(''), transcript);
  assert.ok(requests.at(-1).prompt.includes('FINAL IMPORTANT CONCLUSION'));
  assert.ok(requests.at(-1).system.includes('Use balanced detail'));
  assert.ok(!read('content.js').includes('pl-detail'));
  assert.ok(!read('content.js').includes('pl-preferences'));
  assert.ok(requests.at(-1).system.includes('ANY subject'));
  assert.equal(result.summary.tldr, 'Literature summary');
});

test('short lectures use a single request with no transcript truncation', async () => {
  const { context, requests } = generationContext();
  await context.generate('A short lecture about poetry.', ['summary']);
  assert.equal(requests.length, 1);
  assert.ok(requests[0].prompt.endsWith('A short lecture about poetry.'));
});

test('bracketed timestamps in pasted transcripts remain readable', () => {
  assert.equal(normalize('[00:12] Opening\n[42:00] Conclusion'), '[00:12] Opening\n[42:00] Conclusion');
});

test('subject-neutral rendering preserves dates, URLs and identifiers while formatting explicit math', () => {
  const context = vm.createContext({ katex, window: {}, PanoLearnTranscript: globalThis.PanoLearnTranscript });
  vm.runInContext(read('panel-ui.js').replace(/\}\)\(\);\s*$/, 'globalThis.math = mathHtml;})();'), context);
  assert.equal(context.math('History 1914/1918, https://site.org/a/b, variable_name').__html, 'History 1914/1918, https://site.org/a/b, variable_name');
  assert.ok(context.math('Formula $x^2$').__html.includes('<msup>'));
  assert.equal(context.math('<img src=x onerror=alert(1)>').__html, '&lt;img src=x onerror=alert(1)&gt;');
});

test('hierarchical consolidation includes the last lecture section in final synthesis', async () => {
  const { context, requests } = generationContext();
  context.chrome.runtime.sendMessage = async request => {
    if (request.type !== 'PL_OPENAI') return;
    requests.push(request);
    if (request.system.includes('Required JSON structure')) return { text: '{"summary":{"tldr":"Summary"}}' };
    if (request.system.startsWith('Consolidate')) return { text: request.prompt.slice(-100) };
    return { text: 'Notes. '.repeat(350) + request.prompt.slice(-100) };
  };
  await context.generate('Lecture content. '.repeat(100000) + 'FINAL ENDING', ['summary']);
  assert.ok(requests.some(request => request.system.startsWith('Consolidate')));
  assert.ok(requests.at(-1).prompt.length < 70000);
  assert.ok(requests.at(-1).prompt.includes('FINAL ENDING'));
});

test('captures Panopto DeliveryInfo.aspx responses, not just GetDeliveryInfo', async () => {
  const { context, messages } = frameContext();
  vm.runInContext(read('sniffer.js'), context);
  vm.runInContext(read('transcript.js'), context);
  vm.runInContext(read('capture.js'), context);
  await vm.runInContext('fetch("/Panopto/Pages/Viewer/DeliveryInfo.aspx")', context);
  await tick();
  assert.ok(messages.some(m => m.type === 'PL_TRANSCRIPT' && m.text === '[0:00] Early caption'));
});

test('loaded-caption fallback reads timestamped transcript rows including the ending', () => {
  const rows = [
    { text: 'INSTRUCTOR: Hi.', time: '0:00' },
    { text: 'Welcome to the\nfirst lecture video.', time: '0:01' },
    { text: 'Final lecture topic.', time: '48:20' },
    { text: 'Unrelated control', time: 'not a timestamp' }
  ].map(({text,time}) => ({ querySelector(selector) {
    return selector === '.event-text' ? { innerText: text } : { textContent: time };
  } }));
  const doc = { querySelectorAll(selector) {
    assert.equal(selector, '.event-tab-list li[id^="UserCreatedTranscript-"]');
    return rows;
  } };
  const text = globalThis.PanoLearnTranscript.readPanoptoCaptions(doc);
  assert.equal(text, '[0:00] INSTRUCTOR: Hi.\n[0:01] Welcome to the first lecture video.\n[48:20] Final lecture topic.');
});

test('missing or expired Google sessions never make billable requests', async () => {
  let calls = 0;
  const { context } = backgroundContext(async () => { calls++; });
  context.chrome.storage.session.get = async () => ({});
  await assert.rejects(context.callOpenAI({ system: 'Study', prompt: 'Lecture' }), /Sign in with Google/);
  context.chrome.storage.session.get = async () => ({ plAccount: { token: 'expired', expiresAt: 0 } });
  await assert.rejects(context.callOpenAI({ system: 'Study', prompt: 'Lecture' }), /Sign in with Google/);
  assert.equal(calls, 0);
});

test('OpenAI failed responses and HTTP authentication errors surface clearly', async () => {
  const { context } = backgroundContext(async () => stream([{ type: 'response.failed', response: { error: { message: 'Failed generation' } } }]));
  await assert.rejects(context.callOpenAI({ system: 'Study', prompt: 'Lecture' }), /Failed generation/);
  context.fetch = async () => ({ ok: false, status: 401, json: async () => ({ error: { message: 'Incorrect API key provided' } }) });
  await assert.rejects(context.callOpenAI({ system: 'Study', prompt: 'Lecture' }), /session expired/);
});

test('a 44,402-character lecture takes one request and includes all source text', async () => {
  const { context, requests } = generationContext();
  const transcript = 'Lecture '.repeat(5548) + 'FINAL CONCLUSION!!';
  assert.equal(transcript.length, 44402);
  await context.generate(transcript, ['summary']);
  assert.equal(requests.length, 1);
  assert.ok(requests[0].prompt.endsWith(transcript));
  assert.ok(requests[0].prompt.length < 70000);
  const checked = [...read('content.js').matchAll(/id="(pl-cb-[^"]+)" checked/g)].map(m => m[1]);
  assert.deepEqual(checked, ['pl-cb-summary']);
});

test('long lecture requests run concurrently with a limit of three and retain source order', async () => {
  const { context } = generationContext();
  let active = 0, peak = 0;
  const prompts = [];
  context.chrome.runtime.sendMessage = async request => {
    if (request.type !== 'PL_OPENAI') return;
    if (request.system.includes('Required JSON structure')) {
      prompts.push(request.prompt);
      return { text: '{"summary":{"tldr":"Summary"}}' };
    }
    active++;
    peak = Math.max(peak, active);
    const number = Number(request.prompt.match(/^Part (\d+)/)[1]);
    await new Promise(resolve => setTimeout(resolve, number === 1 ? 20 : 1));
    active--;
    return { text: 'Content for part ' + number };
  };
  await context.generate('X'.repeat(250000), ['summary']);
  assert.equal(peak, 3);
  assert.equal(active, 0);
  assert.ok(prompts[0].indexOf('Content for part 1') < prompts[0].indexOf('Content for part 2'));
  assert.ok(prompts[0].includes('Content for part 5'));
});

test('timeline displays numeric seconds as minutes:seconds, including hour-long lectures', () => {
  const { timelineItem, parseTime, formatTime, videoLink } = globalThis.PanoLearnTranscript;
  const item = timelineItem({ start_seconds: 1792.67, end_seconds: 1851.58, topic: 'Distance' });
  assert.equal(item.segment, '29:52 ~ 30:51');
  assert.equal(timelineItem({ start_seconds: 332.96, end_seconds: 406.33 }).segment, '5:32 ~ 6:46');
  assert.equal(formatTime(3723), '62:03');
  assert.equal(parseTime('1:02:03'), 3723);
  assert.equal(parseTime('332:96'), null);
  assert.equal(timelineItem({ start_seconds: 30, end_seconds: 20 }).start_seconds, null);
  assert.equal(timelineItem({ start_seconds: null, end_seconds: null }).start_seconds, null);
  const link = videoLink('https://school.panopto.com/Panopto/Pages/Embed.aspx?id=lecture', 1792.67);
  assert.ok(link.includes('/Viewer.aspx?'));
  assert.equal(new URL(link).searchParams.get('start'), '1792.67');
  assert.equal(videoLink('javascript:alert(1)', 30), null);
});

test('timeline anchor seeks on normal click and preserves modified-click navigation', () => {
  const sought = [];
  const context = vm.createContext({ katex, window: {}, PanoLearnTranscript: globalThis.PanoLearnTranscript });
  vm.runInContext(read('panel-ui.js').replace(/\}\)\(\);\s*$/, `globalThis.timeline = TimelineItem;
    _options = {pageUrl:'https://school.panopto.com/Panopto/Pages/Viewer.aspx?id=lecture',onSeek:seconds=>globalThis.sought.push(seconds)};})();`), context);
  context.sought = sought;
  const item = globalThis.PanoLearnTranscript.timelineItem({ start_seconds: 332.96, end_seconds: 406.33 });
  const anchor = context.timeline(item).children.find(node => node.tag === 'a');
  assert.equal(anchor.children[0], '5:32 ~ 6:46');
  let prevented = false;
  anchor.props.onClick({ button: 0, preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  assert.deepEqual(sought, [332.96]);
  anchor.props.onClick({ button: 0, metaKey: true, preventDefault() { assert.fail('modified clicks must navigate normally'); } });
  assert.deepEqual(sought, [332.96]);
});

test('timeline seeking routes to the original lecture document and rejects invalid times', async () => {
  const { listener, relays } = backgroundContext();
  const sender = { id: 'extension', tab: { id: 7 }, frameId: 0 };
  listener({ type: 'PL_SEEK', seconds: 332, frameId: 9, documentId: 'lecture-doc', pageUrl: 'https://school.panopto.com/' }, sender, () => {});
  assert.equal(relays[0][0], 7);
  assert.equal(relays[0][2].documentId, 'lecture-doc');
  assert.equal(relays[0][1].seconds, 332);
  let error;
  listener({ type: 'PL_SEEK', seconds: -1, frameId: 9, documentId: 'lecture-doc' }, sender, reply => { error = reply; });
  assert.equal(error.ok, false);
  assert.equal(relays.length, 1);
});

test('player seeking clicks the native caption and refuses a different lecture', () => {
  const { context, runtimeListeners } = frameContext();
  let clicked = 0;
  context.document.querySelectorAll = () => [{ querySelector: () => ({ textContent: '5:32' }), click: () => { clicked++; } }];
  vm.runInContext(read('transcript.js'), context);
  vm.runInContext(read('capture.js'), context);
  let response;
  runtimeListeners[0]({ type: 'PL_SEEK_PLAYER', seconds: 332.96, pageUrl: context.location.href }, {}, reply => { response = reply; });
  assert.equal(response.ok, true);
  assert.equal(clicked, 1);
  runtimeListeners[0]({ type: 'PL_SEEK_PLAYER', seconds: 332, pageUrl: 'different lecture' }, {}, reply => { response = reply; });
  assert.equal(response.ok, false);
  assert.equal(clicked, 1);
});

test('combined short lectures use one request with distinct source identities', async () => {
  const { context, requests } = generationContext();
  await context.generate('', ['summary', 'timeline'], [
    { id: 'L1', label: 'Poetry', text: '[0:00] Metaphor and imagery.' },
    { id: 'L2', label: 'History', text: '[0:00] Historical context.' }
  ]);
  assert.equal(requests.length, 1);
  assert.ok(requests[0].prompt.includes('LECTURE L1 — Poetry\n[L1:C1] [0:00] Metaphor and imagery.'));
  assert.ok(requests[0].prompt.includes('LECTURE L2 — History\n[L2:C1] [0:00] Historical context.'));
  assert.ok(requests[0].system.includes('never cumulative'));
});

test('combined long lectures preserve lecture identity on every chunk and cover the ending', async () => {
  const { context, requests } = generationContext();
  const lectures = [
    { id: 'L1', label: 'First', text: 'A'.repeat(80000) + 'FIRST END' },
    { id: 'L2', label: 'Second', text: 'B'.repeat(80000) + 'SECOND END' }
  ];
  await context.generate('', ['summary'], lectures);
  for (const lecture of lectures) {
    const parts = requests.slice(0, -1).filter(request => request.prompt.includes('LECTURE ' + lecture.id));
    assert.equal(parts.length, 2);
    assert.equal(parts.map(request => request.prompt.replace(/^Part \d+\/\d+\nLECTURE [^\n]+\n/, '')).join(''), lecture.text);
    assert.ok(requests.at(-1).prompt.includes('LECTURE ' + lecture.id));
  }
  assert.ok(requests.at(-1).prompt.includes('SECOND END'));
  assert.ok(requests.every(request => request.prompt.length < 70000));
});

test('combined timelines link to their own lecture and never fall back for unknown sources', () => {
  const context = vm.createContext({ katex, window: {}, PanoLearnTranscript: globalThis.PanoLearnTranscript });
  vm.runInContext(read('panel-ui.js').replace(/\}\)\(\);\s*$/, `globalThis.timeline = TimelineItem;
    _options = {pageUrl:'https://school.panopto.com/?id=current',lectures:[
      {id:'L1',label:'First',pageUrl:'https://school.panopto.com/?id=one'},
      {id:'L2',label:'Second',pageUrl:'https://school.panopto.com/?id=two'}]};})();`), context);
  const item = { lecture_id: 'L2', start_seconds: 95, segment: '1:35' };
  const anchor = context.timeline(item).children.find(node => node?.tag === 'a');
  assert.equal(new URL(anchor.props.href).searchParams.get('id'), 'two');
  assert.equal(new URL(anchor.props.href).searchParams.get('start'), '95');
  anchor.props.onClick({ button: 0, preventDefault() { assert.fail('combined timelines open their linked lecture'); } });
  assert.ok(!context.timeline({ ...item, lecture_id: 'unknown' }).children.some(node => node?.tag === 'a'));
});

test('lecture shelf survives navigation, deduplicates tracks, and removes only the requested lecture', async () => {
  const { context } = generationContext();
  const data = {};
  const elements = new Map();
  function element() {
    return { children: [], value: '', textContent: '', append(...nodes) { this.children.push(...nodes); },
      appendChild(node) { this.children.push(node); }, replaceChildren() { this.children = []; },
      setAttribute() {}, addEventListener(type, fn) { this[type] = fn; } };
  }
  context.URL = URL;
  context.document.createElement = element;
  context.document.getElementById = id => {
    if (!elements.has(id)) elements.set(id, element());
    return elements.get(id);
  };
  context.chrome.storage = { local: {
    get: async () => ({ ...data }), set: async entries => Object.assign(data, entries),
    remove: async key => { delete data[key]; }
  } };
  vm.runInContext(read('content.js').replace(/\}\)\(\);\s*$/, `globalThis.shelf = {
    save:saveCurrentLecture,load:loadLectures,saved:savedLectures,checked:checkedLectures,
    select(source) { sources.set('track',source); selectedSource='track'; }
  };})();`), context);
  context.shelf.select({ pageUrl: 'https://school.panopto.com/Pages/Viewer.aspx?id=ONE&start=12', label: 'First', text: 'Opening' });
  await context.shelf.save();
  context.shelf.select({ pageUrl: 'https://school.panopto.com/Pages/Embed.aspx?id=one', label: 'First', text: 'Complete lecture' });
  await context.shelf.save();
  assert.equal(Object.keys(data).length, 1);
  assert.equal(Object.values(data)[0].text, 'Complete lecture');
  context.shelf.select({ pageUrl: 'https://school.panopto.com/?id=two', label: 'Second', text: 'Second lecture' });
  await context.shelf.save();
  context.shelf.saved.clear();
  await context.shelf.load();
  assert.equal(context.shelf.saved.size, 2);
  const list = elements.get('pl-lecture-list');
  await list.children[0].children[1].click();
  assert.equal(context.shelf.saved.size, 1);
  assert.equal(context.shelf.checked.size, 1);
  assert.equal(Object.values(data)[0].label, 'Second');
});

test('structured summaries validate explanations and table shape and export numbered headings', () => {
  const { context } = generationContext();
  const result = { summary: {
    main_topics: [{ title: 'Vectors', explanation: 'Vectors have magnitude and direction.' }],
    table: { caption: 'Comparison', columns: ['Type', 'Meaning'], rows: [['Scalar', 'Magnitude | only']] }
  } };
  context.validate(result);
  const md = context.markdown(result);
  assert.ok(md.includes('1. **Vectors**\n\n   Vectors have magnitude and direction.'));
  assert.ok(md.includes('| Scalar | Magnitude \\| only |'));
  assert.throws(() => context.validate({ summary: { main_topics: [{ title: 'Missing explanation' }] } }), /Invalid summary/);
  assert.throws(() => context.validate({ summary: { table: { ...result.summary.table, rows: [['Too short']] } } }), /Invalid summary table/);
  context.validate({ summary: { main_topics: ['Legacy topic'] } });
});

test('summary renderer uses ordered bold headings, escaped explanations, and semantic tables', () => {
  const context = vm.createContext({ katex, window: {}, PanoLearnTranscript: globalThis.PanoLearnTranscript });
  vm.runInContext(read('panel-ui.js').replace(/\}\)\(\);\s*$/, 'globalThis.build = buildUI;})();'), context);
  const tree = context.build({ summary: {
    main_topics: [{ title: 'First idea', explanation: '<img src=x onerror=alert(1)> Explanation' }],
    table: { caption: 'Compare', columns: ['A', 'B'], rows: [['One', 'Two']] }
  } });
  const nodes = [];
  function visit(value) {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) return value.forEach(visit);
    nodes.push(value);
    visit(value.children);
  }
  visit(tree);
  assert.ok(nodes.some(node => node.tag === 'ol'));
  assert.ok(nodes.some(node => node.tag === 'strong' && node.props.dangerouslySetInnerHTML.__html === 'First idea'));
  const paragraph = nodes.find(node => node.tag === 'p');
  assert.ok(paragraph.props.dangerouslySetInnerHTML.__html.includes('&lt;img'));
  assert.ok(nodes.some(node => node.tag === 'table'));
  assert.equal(nodes.filter(node => node.tag === 'th' && node.props.scope === 'col').length, 2);
});

test('summary topic references seek the current video and link combined topics to the right lecture', () => {
  const sought = [];
  const context = vm.createContext({ katex, window: {}, PanoLearnTranscript: globalThis.PanoLearnTranscript, sought });
  vm.runInContext(read('panel-ui.js').replace(/\}\)\(\);\s*$/, `globalThis.references = SummaryReferences;
    globalThis.options = value => { _options = value; };})();`), context);
  const refs = [{ lecture_id: 'L2', start_seconds: 332.96, end_seconds: 406.33 }];
  context.options({ pageUrl: 'https://school.panopto.com/?id=current', onSeek: seconds => sought.push(seconds) });
  const anchor = context.references(refs).children[0];
  assert.equal(anchor.children[0], '5:32 ~ 6:46');
  let prevented = false;
  anchor.props.onClick({ button: 0, preventDefault() { prevented = true; } });
  assert.ok(prevented);
  assert.deepEqual(sought, [332.96]);
  anchor.props.onClick({ button: 0, metaKey: true, preventDefault() { assert.fail(); } });
  context.options({ lectures: [{ id: 'L2', label: 'Second lecture', pageUrl: 'https://school.panopto.com/?id=second' }] });
  const combined = context.references(refs).children[0];
  assert.equal(new URL(combined.props.href).searchParams.get('id'), 'second');
  assert.equal(combined.children[0], 'Second lecture · 5:32 ~ 6:46');
  combined.props.onClick({ button: 0, preventDefault() { assert.fail(); } });
  context.options({});
  assert.equal(context.references(refs).children[0].tag, 'span');
});

test('summary timestamps reject invalid values and the separate Timeline selector is removed', () => {
  const { context } = generationContext();
  const result = context.validate({ summary: { main_topics: [{ title: 'Topic', explanation: 'Explanation', references: [
    { start_seconds: 0, end_seconds: 65 }, { start_seconds: -1 }, { start_seconds: '332:96' }
  ] }] } });
  const refs = result.summary.main_topics[0].references;
  assert.equal(refs.length, 3);
  assert.equal(refs[0].segment, '0:00 ~ 1:05');
  assert.ok(context.markdown(result).includes('0:00 ~ 1:05'));
  assert.ok(!read('content.js').includes('pl-cb-timeline'));
  assert.throws(() => context.validate({ summary: { main_topics: [{ title: 'Topic', explanation: 'Text', references: [null] }] } }), /Invalid summary timestamps/);
});

test('sphere equations render grouped powers and coordinate subscripts as notation', () => {
  const context = vm.createContext({ katex, window: {}, PanoLearnTranscript: globalThis.PanoLearnTranscript });
  vm.runInContext(read('panel-ui.js').replace(/\}\)\(\);\s*$/, 'globalThis.math = mathHtml;})();'), context);
  const html = context.math('Sphere: $(x - x_{0})^{2} + (y - y_{0})^2 + (z - z_{0})^{2} = r^2$.').__html;
  assert.equal((html.match(/<msup>/g) || []).length, 4);
  assert.equal((html.match(/<msub>/g) || []).length, 3);
  assert.ok(!html.includes('pl-math-error'));
  assert.ok(context.math('$r^{-2}$').__html.includes('<mn>2</mn>'));
  assert.equal(context.math('Release x0 on 2026/09/11; file_name').__html, 'Release x0 on 2026/09/11; file_name');
});

test('bundled math engine renders calculus, vectors, roots, matrices and piecewise formulas', () => {
  const context = vm.createContext({ katex, window: {}, PanoLearnTranscript: globalThis.PanoLearnTranscript });
  vm.runInContext(read('panel-ui.js').replace(/\}\)\(\);\s*$/, 'globalThis.math = mathHtml;})();'), context);
  const formulas = [
    [String.raw`$\frac{\partial f}{\partial x}$`, '<mfrac>'],
    [String.raw`\(\sqrt{x^2+y^2}\)`, '<msqrt>'],
    [String.raw`$$\int_0^1 x^2\,dx = \frac{1}{3}$$`, 'pl-equation-block'],
    [String.raw`\[\sum_{n=1}^{\infty}\frac{1}{n^2}\]`, '<munderover>'],
    [String.raw`$\vec{a}\cdot\vec{b}=\lVert a\rVert\lVert b\rVert\cos\theta$`, '<mover'],
    [String.raw`$\begin{pmatrix}1 & 2 \\ 3 & 4\end{pmatrix}$`, '<mtable'],
    [String.raw`$f(x)=\begin{cases}x^2 & x<0\\x & x\geq0\end{cases}$`, '<mtable']
  ];
  for (const [source, expected] of formulas) {
    const html = context.math(source).__html;
    assert.ok(html.includes(expected), source);
    assert.ok(!html.includes('pl-math-error'), source);
  }
  const mixed = context.math(String.raw`Pay $5 and $10; https://site.org/a/b; then $\alpha^2$.`).__html;
  assert.ok(mixed.startsWith('Pay $5 and $10; https://site.org/a/b; then '));
  assert.ok(mixed.includes('<msup>'));
  const broken = context.math(String.raw`Bad $\frac{1}{$; good $x^2$; <img onerror=alert(1)>`).__html;
  assert.ok(broken.includes('pl-math-error'));
  assert.ok(broken.includes('<msup>'));
  assert.ok(!broken.includes('<img'));
  const hostile = context.math(String.raw`$\href{javascript:alert(1)}{click}$`).__html;
  assert.ok(!hostile.includes('href="javascript:'));
});

test('extension loads bundled KaTeX before every panel renderer', () => {
  const manifest = JSON.parse(read('manifest.json'));
  const scripts = manifest.content_scripts.find(item => item.js.includes('panel-ui.js')).js;
  assert.ok(scripts.indexOf('vendor/katex/katex.min.js') < scripts.indexOf('panel-ui.js'));
  assert.ok(!read('panel-ui.js').includes('function formatMath'));
});

test('loading bar remains visible during generation and clears after success or failure', async () => {
  for (const fail of [false, true]) {
    const { context } = generationContext();
    const elements = new Map();
    context.document.getElementById = id => {
      if (!elements.has(id)) elements.set(id, { style: {}, value: '', checked: id === 'pl-cb-summary',
        setAttribute(name, value) { this[name] = value; }, appendChild() {} });
      return elements.get(id);
    };
    context.document.createElement = () => ({ style: {}, appendChild() {} });
    context.window.PanoLearnUI = { mount() {} };
    vm.runInContext(read('content.js').replace(/\}\)\(\);\s*$/, 'globalThis.handle = handleGenerate;})();'), context);
    context.document.getElementById('pl-manual-transcript').value = 'Lecture transcript';
    let finish;
    context.chrome.runtime.sendMessage = () => new Promise(resolve => { finish = resolve; });
    const pending = context.handle();
    assert.equal(elements.get('pl-loading').style.display, 'block');
    await tick();
    assert.equal(elements.get('pl-loading-status').textContent, 'Writing summary…');
    assert.equal(elements.get('pl-results')['aria-busy'], 'true');
    finish(fail ? { error: 'Failed request' } : { text: '{"summary":{"tldr":"Notes"}}' });
    await pending;
    assert.equal(elements.get('pl-loading').style.display, 'none');
    assert.equal(elements.get('pl-results')['aria-busy'], 'false');
    assert.equal(elements.get('pl-generate-btn').disabled, false);
    assert.equal(elements.get('pl-loading-percent').textContent, fail ? '85%' : '100%');
    assert.equal(elements.get('pl-loading-track')['aria-valuenow'], fail ? '85' : '100');
    if (fail) assert.ok(elements.get('pl-error').textContent.includes('Failed request'));
  }
});

test('Chapter 14.3 unmarked notation is recovered without changing prose or code', () => {
  const context = vm.createContext({ katex, window: {}, PanoLearnTranscript: globalThis.PanoLearnTranscript });
  vm.runInContext(read('panel-ui.js').replace(/\}\)\(\);\s*$/, 'globalThis.math = mathHtml;})();'), context);
  const cases = [
    ['Functions like f(x,y) on z=f(x,y).', '<mi>f</mi>'],
    ['Partial derivatives f_x or ∂f/∂x and f_y or ∂f/∂y.', '<mfrac>'],
    ['Compute x^y and f_xx, f_yy, f_xy, f_yx.', '<msub>'],
    ['Solve for dz/dx and dz/dy.', '<mfrac>'],
    [String.raw`An unmarked \frac{1}{2} or \sqrt{x}.`, '<mfrac>'],
    ['Padded $ x^{2} $ and $ f_{xy} $ work.', '<msup>']
  ];
  for (const [source, expected] of cases) {
    const html = context.math(source).__html;
    assert.ok(html.includes(expected), source);
    assert.ok(!html.includes('pl-math-error'), source);
  }
  const secondPartial = context.math('f_xy').__html;
  assert.ok(secondPartial.includes('<msub><mi>f</mi><mrow><mi>x</mi><mi>y</mi></mrow></msub>'));
  for (const text of ['variable_name and file_name', 'https://site.org/f_x and src/file_name', '`f_x` in code', 'Pay $5 and $10.', 'Date 2026/09/11 and 1914/1918']) {
    assert.equal(context.math(text).__html, text);
  }
  assert.ok(!context.math('f_x <img src=x onerror=alert(1)>').__html.includes('<img'));
});

test('topic and example timestamps resolve to original transcript cues, never nearest rounded times', () => {
  const { groundReferences, cues } = globalThis.PanoLearnTranscript;
  const lectures = [
    { id: 'L1', text: '[0:03] Today we discuss partial derivatives.\n[7:23] Let us find the derivative of x squared y.\n[8:11] Treat y as constant and differentiate x squared.\n[9:02] Here is another example.\n[10:01] Here is another example.' },
    { id: 'L2', text: '[0:08] Let us find the derivative of x squared y.' }
  ];
  const result = { summary: { main_topics: [{ references: [
    { lecture_id: 'L1', kind: 'example', start_seconds: 420, end_seconds: 500, source_quote: 'Let us find the derivative of x squared y.' },
    { lecture_id: 'L2', start_seconds: 420, source_quote: 'Let us find the derivative of x squared y.' },
    { lecture_id: 'L1', start_seconds: 420, source_quote: 'Here is another example.' },
    { lecture_id: 'L1', start_seconds: 443, source_quote: 'Invented transcript evidence.' },
    { lecture_id: 'unknown', start_seconds: 443, source_quote: 'Let us find the derivative of x squared y.' }
  ] }] } };
  result.summary.main_topics = result.summary.main_topics[0].references.map(ref => ({ references: [ref] }));
  const refs = groundReferences(result, lectures).summary.main_topics.flatMap(topic => topic.references);
  assert.equal(refs[0].start_seconds, 443);
  assert.equal(refs[0].segment, '7:23');
  assert.equal(refs[0].end_seconds, null);
  assert.equal(refs[1].start_seconds, 8);
  assert.equal(refs[2].start_seconds, null);
  assert.equal(refs[3].start_seconds, 443);
  assert.equal(refs[3].verified, false);
  assert.equal(refs[3].timing_basis, 'timestamp');
  assert.equal(refs[4].start_seconds, null);
  assert.equal(cues('00:07:23,500 --> 00:07:30,000\nExample starts here.')[0].start, 443.5);
});

test('worked examples display problem notes and timestamps, including an honest untimed fallback', () => {
  const context = vm.createContext({ katex, window: {}, PanoLearnTranscript: globalThis.PanoLearnTranscript });
  vm.runInContext(read('panel-ui.js').replace(/\}\)\(\);\s*$/, `globalThis.references = SummaryReferences;
    _options = {pageUrl:'https://school.panopto.com/?id=lecture'};})();`), context);
  const ref = { kind: 'example', label: 'Differentiate x^2', note: 'Apply the power rule.', start_seconds: 443 };
  const node = context.references([ref]).children[0];
  assert.equal(node.props.className, 'pl-worked-example');
  assert.ok(node.children[0].props.dangerouslySetInnerHTML.__html.includes('Worked example:'));
  assert.equal(new URL(node.children[1].props.href).searchParams.get('start'), '443');
  const untimed = context.references([{ ...ref, start_seconds: null }]).children[0];
  assert.equal(untimed.children[1].tag, 'span');
  assert.ok(untimed.children[1].children[0].includes('Time unavailable'));
});

test('timestamp recovery accepts cross-cue quotes, punctuation changes and absent quotes', () => {
  const source = [{ id: 'L1', text: '[7:23] Let’s find the partial\n[7:25] derivative of this function.\n[7:30] Hold y constant.' }];
  const result = { summary: { main_topics: [{ references: [
    { start_seconds: null, source_quote: 'Lets find the partial derivative of this function' },
    { start_seconds: 445, source_quote: '' },
    { start_seconds: 450, source_quote: 'Hold y constant' }
  ] }] } };
  // Apostrophe punctuation normalizes to spaces on both sides of a quote.
  result.summary.main_topics[0].references[0].source_quote = "Let's find the partial derivative of this function";
  result.summary.main_topics = result.summary.main_topics[0].references.map(ref => ({ references: [ref] }));
  const refs = globalThis.PanoLearnTranscript.groundReferences(result, source).summary.main_topics.flatMap(topic => topic.references);
  assert.equal(refs[0].start_seconds, 443);
  assert.equal(refs[0].verified, true);
  assert.equal(refs[1].start_seconds, 445);
  assert.equal(refs[1].timing_basis, 'timestamp');
  assert.equal(refs[2].start_seconds, 450);
  assert.ok(refs.every(ref => ref.lecture_id === 'L1'));
});

test('stable cue IDs resolve timestamps even when the model omits times or paraphrases quotes', async () => {
  const { context, requests } = generationContext();
  context.chrome.runtime.sendMessage = async request => {
    requests.push(request);
    return { text: JSON.stringify({ summary: { main_topics: [{ title: 'Example', explanation: 'Solve it', references: [
      { cue_id: 'L1:C2', start_seconds: null, source_quote: 'Paraphrased source' }
    ] }] } }) };
  };
  const result = await context.generate('[0:00] Introduction\n[7:23] Let us solve this problem.', ['summary']);
  assert.ok(requests[0].prompt.includes('[L1:C2] [7:23]'));
  const ref = result.summary.main_topics[0].references[0];
  assert.equal(ref.start_seconds, 443);
  assert.equal(ref.segment, '7:23');
  assert.equal(ref.timing_basis, 'cue_id');
  assert.equal(ref.lecture_id, 'L1');
});

test('worked examples survive generation, timestamp resolution, rendering and Markdown export independently', async () => {
  const { context } = generationContext();
  context.chrome.runtime.sendMessage = async () => ({ text: JSON.stringify({ summary: {
    main_topics: [{ title: 'Partial derivatives', explanation: 'Hold the other variable constant.', references: [{ cue_id: 'L1:C1' }] }],
    worked_examples: [
      { label: 'Differentiate x^2 y', note: 'Hold y constant. The result is 2xy.', cue_id: 'L1:C2' },
      { label: 'Additional example', note: 'Keep this explanation even without a timestamp.' }
    ]
  } }) });
  const result = await context.generate('[0:03] Partial derivatives\n[7:23] Find the derivative of x squared y.', ['summary']);
  assert.equal(result.summary.worked_examples.length, 2);
  assert.equal(result.summary.worked_examples[0].start_seconds, 443);
  assert.equal(result.summary.worked_examples[1].start_seconds, null);
  assert.ok(context.markdown(result).includes('**Worked example: Differentiate x^2 y**'));
  assert.ok(context.markdown(result).includes('Keep this explanation'));
  const renderer = vm.createContext({ katex, window: {}, PanoLearnTranscript: globalThis.PanoLearnTranscript });
  vm.runInContext(read('panel-ui.js').replace(/\}\)\(\);\s*$/, `globalThis.build = buildUI;
    _options = {pageUrl:'https://school.panopto.com/?id=lecture'};})();`), renderer);
  const tree = renderer.build(result);
  const nodes = [];
  function visit(value) {
    if (Array.isArray(value)) return value.forEach(visit);
    if (!value || typeof value !== 'object') return;
    nodes.push(value);
    visit(value.children);
  }
  visit(tree);
  assert.equal(nodes.filter(node => node.props?.className === 'pl-worked-example').length, 2);
  assert.ok(nodes.some(node => node.tag === 'a' && new URL(node.props.href).searchParams.get('start') === '443'));
});

test('legacy examples migrate to the independent example list without duplicates', () => {
  const { context } = generationContext();
  const example = { kind: 'example', label: 'Problem', note: 'Solution', cue_id: 'L1:C2' };
  const result = context.validate({ summary: { main_topics: [{ title: 'Topic', explanation: 'Text', references: [example] }], worked_examples: [example] } });
  assert.equal(result.summary.main_topics[0].references.length, 0);
  assert.equal(result.summary.worked_examples.length, 1);
});

test('worked examples are placed under their assigned topic in the UI and Markdown', () => {
  const { context } = generationContext();
  const result = { summary: {
    main_topics: [
      { id: 'T1', title: 'First topic', explanation: 'First explanation' },
      { id: 'T2', title: 'Second topic', explanation: 'Second explanation' }
    ],
    worked_examples: [
      { topic_id: 'T2', label: 'Second problem', note: 'Second solution', start_seconds: 200 },
      { topic_id: 'T1', label: 'First problem', note: 'First solution', start_seconds: 100 }
    ]
  } };
  const grouped = globalThis.PanoLearnTranscript.groupExamples(result.summary);
  assert.equal(grouped.groups[0][0].label, 'First problem');
  assert.equal(grouped.groups[1][0].label, 'Second problem');
  assert.equal(grouped.unassigned.length, 0);
  const md = context.markdown(result);
  assert.ok(md.indexOf('First problem') < md.indexOf('2. **Second topic**'));
  assert.ok(md.indexOf('Second problem') > md.indexOf('2. **Second topic**'));
  const renderer = vm.createContext({ katex, window: {}, PanoLearnTranscript: globalThis.PanoLearnTranscript });
  vm.runInContext(read('panel-ui.js').replace(/\}\)\(\);\s*$/, 'globalThis.build = buildUI;})();'), renderer);
  const nodes = [];
  function visit(node) {
    if (Array.isArray(node)) return node.forEach(visit);
    if (!node || typeof node !== 'object') return;
    nodes.push(node); visit(node.children);
  }
  visit(renderer.build(result));
  const outline = nodes.find(node => node.tag === 'ol');
  assert.ok(JSON.stringify(outline.children[0]).includes('First problem'));
  assert.ok(!JSON.stringify(outline.children[0]).includes('Second problem'));
  assert.ok(JSON.stringify(outline.children[1]).includes('Second problem'));
  assert.equal(globalThis.PanoLearnTranscript.groupExamples({ ...result.summary, worked_examples: [{ topic_id: 'missing' }] }).unassigned.length, 1);
});

test('each topic has one start-to-end range and each worked example keeps its separate range', () => {
  const result = { summary: {
    main_topics: [{ id: 'T1', references: [
      { cue_id: 'L1:C1', end_cue_id: 'L1:C5' },
      { cue_id: 'L1:C2', end_cue_id: 'L1:C3' },
      { cue_id: 'L1:C3', end_cue_id: 'L1:C4' }
    ] }],
    worked_examples: [{ topic_id: 'T1', kind: 'example', cue_id: 'L1:C3', end_cue_id: 'L1:C4' }]
  } };
  const source = [{ id: 'L1', text: '[1:00] Topic starts\n[2:00] Definition\n[3:15] Example starts\n[4:20] Example ends\n[5:30] Next topic' }];
  globalThis.PanoLearnTranscript.groundReferences(result, source);
  assert.equal(result.summary.main_topics[0].references.length, 1);
  assert.equal(result.summary.main_topics[0].references[0].segment, '1:00 ~ 5:30');
  assert.equal(result.summary.worked_examples[0].segment, '3:15 ~ 4:20');
  assert.equal(result.summary.worked_examples[0].start_seconds, 195);
});

test('examples nested under topics are retained and assigned to their owning topic', () => {
  const { context } = generationContext();
  const result = context.validate({ summary: { main_topics: [
    { id: 'T1', title: 'Differentiation', explanation: 'Theory', worked_examples: [
      { label: 'Find a derivative', note: 'Apply the power rule.', cue_id: 'L1:C2', end_cue_id: 'L1:C3' }
    ] },
    { id: 'T2', title: 'Integration', explanation: 'Theory', worked_examples: [
      { label: 'Find an integral', note: 'Apply substitution.' }
    ] }
  ] } });
  const grouped = globalThis.PanoLearnTranscript.groupExamples(result.summary);
  assert.equal(result.summary.worked_examples.length, 2);
  assert.equal(grouped.groups[0][0].label, 'Find a derivative');
  assert.equal(grouped.groups[1][0].label, 'Find an integral');
  assert.equal(grouped.groups[1][0].start_seconds, null);
  assert.equal(context.validate(result).summary.worked_examples.length, 2);
  assert.ok(context.markdown(result).includes('Apply substitution.'));
});

test('different worked problems sharing a title and opening cue are not discarded', () => {
  const { context } = generationContext();
  const first = { topic_id: 'T1', label: 'Example', note: 'Differentiate x squared.', cue_id: 'L1:C2' };
  const second = { ...first, note: 'Differentiate x cubed.' };
  const result = context.validate({ summary: { worked_examples: [first, second, { ...first }] } });
  assert.equal(result.summary.worked_examples.length, 2);
});

test('lectures without worked examples do not get placeholder problems', async () => {
  const { context } = generationContext();
  context.chrome.runtime.sendMessage = async () => ({ text: JSON.stringify({ summary: {
    main_topics: [{ id: 'T1', title: 'Definitions', explanation: 'A conceptual discussion.', references: [] }], worked_examples: []
  } }) });
  const result = await context.generate('A conceptual discussion without any solved problem.', ['summary']);
  assert.equal(result.summary.worked_examples.length, 0);
  assert.ok(!context.markdown(result).includes('Worked example:'));
});

test('PDF export creates an isolated print tab with only the notes and source links', async () => {
  const saved = {}, tabs = [];
  const context = vm.createContext({ crypto: { randomUUID: () => 'export-test' }, chrome: {
    runtime: { onMessage: { addListener() {} }, getURL: path => 'chrome-extension://test/' + path },
    storage: { session: { set: async value => Object.assign(saved, value), remove: async key => delete saved[key] } },
    tabs: { create: async options => tabs.push(options) }
  } });
  context.importScripts = (...files) => files.forEach(file => vm.runInContext(read(file), context));
  vm.runInContext(read('background.js'), context);
  context.PANOLEARN_SERVICE = { apiBaseUrl: 'https://service.example', googleClientId: 'client-test' };
  await context.exportPDF({ result: { summary: { tldr: 'Notes' } }, pageUrl: 'https://school.panopto.com/?id=lecture', lectures: [] });
  assert.equal(saved['plPdf:export-test'].result.summary.tldr, 'Notes');
  assert.equal(tabs[0].url, 'chrome-extension://test/print.html#plPdf%3Aexport-test');
  assert.ok(read('content.js').includes('Save Notes as PDF'));
  assert.ok(!read('content.js').includes('Save Notes as Markdown'));
});

test('print view expands all sections and includes answers without changing normal view defaults', () => {
  const context = vm.createContext({ katex, window: {}, PanoLearnTranscript: globalThis.PanoLearnTranscript });
  vm.runInContext(read('panel-ui.js').replace(/\}\)\(\);\s*$/, `globalThis.exam = ExamItem;
    globalThis.section = Section; globalThis.printMode = value => { _options = {print:value}; };})();`), context);
  const question = { question: 'Question', answer: 'Complete answer' };
  context.printMode(true);
  assert.ok(JSON.stringify(context.exam('q', question)).includes('Complete answer'));
  assert.ok(context.section('a', '', 'Topic', null, '', []).props.className.includes('pl-section--open'));
  context.printMode(false);
  assert.ok(!JSON.stringify(context.exam('q', question)).includes('Complete answer'));
});

test('API enforces strict schemas for inventory and study responses, with plain text only for compression', async () => {
  const bodies = [];
  const quotedMath = JSON.stringify({ note: 'The lecturer says "differentiate" using $\\frac{dy}{dx}$.' });
  const { context } = backgroundContext(async (_, options) => {
    bodies.push(JSON.parse(options.body));
    return stream([{ type: 'response.output_text.delta', delta: quotedMath }, { type: 'response.completed' }]);
  });
  for (const format of ['inventory', 'study', undefined]) {
    assert.equal(await context.callOpenAI({ system: 'Return JSON when requested.', prompt: 'Source', format }), quotedMath);
  }
  for (const [i, name] of ['inventory', 'study'].entries()) {
    assert.equal(bodies[i].format, name);
    const format = context.studyResponseFormat(name);
    assert.equal(format.type, 'json_schema');
    assert.equal(format.name, 'panolearn_' + name);
    assert.equal(format.strict, true);
    function check(schema) {
      if (schema.type === 'object') {
        assert.equal(schema.additionalProperties, false);
        assert.deepEqual(Array.from(schema.required), Object.keys(schema.properties));
        Object.values(schema.properties).forEach(check);
      }
      if (schema.items) check(schema.items);
      if (schema.anyOf) schema.anyOf.forEach(check);
    }
    check(format.schema);
  }
  assert.ok(context.studyResponseFormat('inventory').schema.properties.topics);
  assert.ok(context.studyResponseFormat('study').schema.properties.summary);
  assert.equal(bodies[2].text, undefined);
  await assert.rejects(context.callOpenAI({ system: 'Study', prompt: 'Source', format: 'arbitrary' }), /Invalid response format/);
});

test('malformed final JSON regenerates once from identical source without editing math or quotations', async () => {
  const { context } = generationContext();
  const requests = [];
  const explanation = 'She says "use the quotient rule": $\\frac{x}{y}$.';
  context.chrome.runtime.sendMessage = async request => {
    requests.push(request);
    return { text: requests.length === 1 ? '{"summary":{"tldr":"Notes" "main_topics":[]}}' : JSON.stringify({ summary: { tldr: explanation } }) };
  };
  const result = await context.generate('Original lecture with quotations and formulas.', ['summary']);
  assert.equal(requests.length, 2);
  assert.equal(requests[0].format, 'study');
  assert.equal(requests[1].prompt, requests[0].prompt);
  assert.equal(result.summary.tldr, explanation);
});

test('repeated malformed final JSON gives a bounded readable error instead of a raw parser exception', async () => {
  const { context } = generationContext();
  let calls = 0;
  context.chrome.runtime.sendMessage = async () => { calls++; return { text: '{"broken":"quote"here"}' }; };
  await assert.rejects(context.generate('Lecture', ['summary']), /could not be formatted correctly after an automatic retry/);
  assert.equal(calls, 2);
});

test('authentication or transport failures are not retried as JSON formatting failures', async () => {
  const { context } = generationContext();
  let calls = 0;
  context.chrome.runtime.sendMessage = async () => { calls++; return { error: 'Your session expired' }; };
  await assert.rejects(context.generate('Lecture', ['summary']), /session expired/);
  assert.equal(calls, 1);
});

test('malformed extraction JSON recovers before final summary with both enforced response formats', async () => {
  const { context } = generationContext();
  vm.runInContext(read('accuracy.js'), context);
  const requests = [];
  context.chrome.runtime.sendMessage = async request => {
    requests.push(request);
    if (requests.length === 1) return { text: '{"topics":[{"title":"Missing comma" "note":"broken"}]}' };
    if (request.format === 'inventory') return { text: JSON.stringify({ topics: [{
      title: 'Topic', note: 'A complete explanation.', start_id: 'L1:C1', last_id: 'L1:C2',
      start_quote: 'Introduce the topic.', last_quote: 'Conclude the topic.', complete: true, examples: []
    }] }) };
    return { text: JSON.stringify({ summary: { main_topics: [{ id: 'T1', title: 'Topic', explanation: 'A complete explanation.' }] } }) };
  };
  const result = await context.generate('[0:00] Introduce the topic.\n[0:05] Conclude the topic.\n[0:10] Next topic.', ['summary']);
  assert.deepEqual(requests.map(request => request.format), ['inventory', 'inventory', 'study']);
  assert.equal(result.summary.main_topics[0].references[0].segment, '0:00 ~ 0:10');
});

test('fractions render numerator above denominator with preserved grouping', () => {
  const context = vm.createContext({ katex, window: {}, PanoLearnTranscript: globalThis.PanoLearnTranscript });
  vm.runInContext(read('panel-ui.js').replace(/\}\)\(\);\s*$/, 'globalThis.math = mathHtml; globalThis.stack = stackSimpleFraction;})();'), context);
  for (const formula of ['x/y', '1/2', '(x+1)/(y-2)', 'x^{2}/y_{0}', 'dy/dx', '\\partial f/\\partial x', '\\frac{x+1}{y-2}', '\\dfrac{1}{\\frac{x}{y}}']) {
    const html = context.math('$' + formula + '$').__html;
    assert.ok(html.includes('<mfrac>'), formula);
    assert.ok(!html.includes('pl-math-error'), formula);
  }
  for (const formula of ['a/b+c', 'a/b/c', '2026/09/12', 'https://example.com', '\\frac{x}{y}']) assert.equal(context.stack(formula), formula);
  assert.ok(!context.math('Visit https://example.com/a/b on 2026/09/12. `x/y`').__html.includes('<mfrac>'));
});

test('concise generation instructions preserve essential reasoning and require stacked fractions', async () => {
  const { context, requests } = generationContext();
  await context.generate('Lecture', ['summary']);
  assert.ok(requests[0].system.includes('2–4 short sentences'));
  assert.ok(requests[0].system.includes('exceed this target only when necessary for accuracy'));
  assert.ok(requests[0].system.includes('\\frac{numerator}{denominator}'));
  assert.ok(!requests[0].system.includes('\f'));
  const accuracy = read('accuracy.js');
  assert.ok(accuracy.includes('never drop a necessary step'));
});

test('range recovery uses a strict schema containing only record and caption IDs', () => {
  const { context } = backgroundContext();
  const format = context.studyResponseFormat('timing');
  assert.equal(format.strict, true);
  assert.equal(format.type, 'json_schema');
  assert.deepEqual(Array.from(format.schema.properties.ranges.items.required), ['id', 'start_id', 'last_id']);
  assert.equal(format.schema.properties.ranges.items.additionalProperties, false);
});

test('topics collapse independently, preserve open state, and expand for PDF without example prose', () => {
  const context = vm.createContext({ katex, window: {}, PanoLearnTranscript: globalThis.PanoLearnTranscript });
  vm.runInContext(read('panel-ui.js').replace(/\}\)\(\);\s*$/, `globalThis.build = buildUI;
    globalThis.options = value => { _options = value; };})();`), context);
  const result = { summary: { main_topics: [
    { id: 'T1', title: 'Lines', explanation: 'Topic explanation.', references: [{ start_seconds: 60, end_seconds: 120 }] },
    { id: 'T2', title: 'Planes', explanation: 'Second explanation.' }
  ], worked_examples: [{ topic_id: 'T1', label: 'Find the line', note: 'Setup: HIDDEN EXAMPLE PROSE. Result: HIDDEN RESULT.', start_seconds: 90, end_seconds: 110 }] } };
  function all(node, tag) {
    if (!node || typeof node !== 'object') return [];
    if (Array.isArray(node)) return node.flatMap(item => all(item, tag));
    return [...(node.tag === tag ? [node] : []), ...all(node.children, tag)];
  }
  context.options({ pageUrl: 'https://school.panopto.com/?id=lecture' });
  let tree = context.build(result);
  const topics = all(tree, 'details');
  assert.equal(topics.length, 2);
  assert.ok(topics.every(topic => topic.props.open === false));
  assert.equal(topics[0].children[0].tag, 'summary');
  topics[0].props.onToggle({ currentTarget: { open: true } });
  tree = context.build(result);
  assert.deepEqual(all(tree, 'details').map(topic => topic.props.open), [true, false]);
  assert.ok(JSON.stringify(tree).includes('Topic explanation.'));
  assert.ok(!JSON.stringify(tree).includes('HIDDEN EXAMPLE PROSE'));
  assert.ok(all(tree, 'a').some(link => new URL(link.props.href).searchParams.get('start') === '90'));
  context.options({ print: true, pageUrl: 'https://school.panopto.com/?id=lecture' });
  const printed = context.build(result);
  assert.ok(all(printed, 'details').every(topic => topic.props.open));
  assert.ok(!JSON.stringify(printed).includes('HIDDEN RESULT'));
});

test('symmetric line ratios stack a b and c below their respective numerators', () => {
  const context = vm.createContext({ katex, window: {}, PanoLearnTranscript: globalThis.PanoLearnTranscript });
  vm.runInContext(read('panel-ui.js').replace(/\}\)\(\);\s*$/, 'globalThis.math = mathHtml;})();'), context);
  const html = context.math('$(x-x_0)/a = (y-y_0)/b = (z-z_0)/c$').__html;
  assert.equal((html.match(/<mfrac>/g) || []).length, 3);
  for (const letter of ['a','b','c']) assert.ok(html.includes('<mi>' + letter + '</mi></mfrac>'));
  assert.ok(!html.includes('pl-math-error'));
});

test('JSON control escapes in fractions and vector commands recover without red error text', () => {
  const context = vm.createContext({ katex, window: {}, PanoLearnTranscript: globalThis.PanoLearnTranscript });
  vm.runInContext(read('panel-ui.js').replace(/\}\)\(\);\s*$/, 'globalThis.math = mathHtml; globalThis.repair = repairMathEscapes;})();'), context);
  const damaged = '\f' + 'rac{d\b' + 'oldsymbol{r}}{dt} = \b' + 'oldsymbol{r}(t) = \b' + 'igl\\langle x_0+at,y_0+bt,z_0+ct\b' + 'igr\r' + 'angle';
  const html = context.math('$' + damaged + '$').__html;
  assert.ok(html.includes('<mfrac>'));
  assert.ok(html.includes('<math'));
  assert.ok(!html.includes('pl-math-error'));
  assert.ok(!/[\u0008\u000c\r]/.test(html));
  assert.ok(context.math('$\n' + 'abla f$').__html.includes('<math'));
  assert.equal(context.repair('line one\nline two'), 'line one\nline two');
  assert.ok(context.math('Ordinary\ntext and `\\frac{x}{y}`').__html.includes('Ordinary\ntext'));
});

test('tab-corrupted textbf vector notation renders bold symbols rather than extbf letters', () => {
  const context = vm.createContext({ katex, window: {}, PanoLearnTranscript: globalThis.PanoLearnTranscript });
  vm.runInContext(read('panel-ui.js').replace(/\}\)\(\);\s*$/, 'globalThis.math = mathHtml; globalThis.repair = repairMathEscapes;})();'), context);
  const damaged = '\t' + 'extbf{r}(t) = \t' + 'extbf{r}_0 + t\t' + 'extbf{v}';
  assert.equal(context.repair(damaged), '\\textbf{r}(t) = \\textbf{r}_0 + t\\textbf{v}');
  const html = context.math('$' + damaged + '$').__html;
  const visible = html.replace(/<annotation[\s\S]*?<\/annotation>/g, '');
  assert.ok(visible.includes('mathvariant="bold"'));
  assert.ok(!visible.includes('<mi>e</mi>'));
  assert.ok(!visible.includes('extbf'));
  assert.ok(!visible.includes('pl-math-error'));
  for (const command of ['textbf', 'textit', 'textrm', 'textsf', 'texttt', 'textnormal']) {
    assert.equal(context.repair('\t' + command.slice(1) + '{sample}'), '\\' + command + '{sample}');
  }
  assert.equal(context.repair('first\tsecond'), 'first\tsecond');
});

test('estimated progress uses monotonic stage percentages and never completes before rendering', async () => {
  const { context } = generationContext();
  const percentages = [], nodes = new Map();
  context.document.getElementById = id => {
    if (!nodes.has(id)) nodes.set(id, { style: {}, setAttribute(name, value) { this[name] = value; } });
    return nodes.get(id);
  };
  Object.defineProperty(context.document.getElementById('pl-loading-percent'), 'textContent', { set(value) { percentages.push(Number(value.replace('%', ''))); } });
  context.PanoLearnAccuracy.collect = async (_, __, progress) => {
    progress('First completed', 40);
    progress('Late concurrent update', 20);
    return null;
  };
  await context.generate('Lecture', ['summary']);
  assert.deepEqual(percentages, [5, 40, 40, 85, 95]);
  assert.equal(nodes.get('pl-loading-bar').style.width, '95%');
  assert.equal(nodes.get('pl-loading-track')['aria-valuenow'], '95');
  assert.ok(read('content.js').includes('Estimated progress'));
  assert.ok(!read('panel.css').includes('pl-loading-slide'));
});

test('independent evidence and transcript preparation overlap under one three-request limit', async () => {
  const { context } = generationContext();
  let active = 0, peak = 0, inventoryRunning = false, overlap = false;
  context.PanoLearnAccuracy.collect = async (_, request) => {
    await request('INVENTORY', 'Source evidence', 'inventory');
    return null;
  };
  context.chrome.runtime.sendMessage = async request => {
    active++; peak = Math.max(peak, active);
    if (request.system === 'INVENTORY') inventoryRunning = true;
    else if (request.system.startsWith('Create faithful')) overlap ||= inventoryRunning;
    await new Promise(resolve => setTimeout(resolve, request.system === 'INVENTORY' ? 12 : 2));
    active--;
    if (request.system === 'INVENTORY') { inventoryRunning = false; return { text: '{}' }; }
    if (request.format === 'study') {
      assert.equal(active, 0);
      assert.equal(inventoryRunning, false);
      return { text: '{"summary":{"tldr":"Done"}}' };
    }
    return { text: 'Prepared source notes' };
  };
  const result = await context.generate('Lecture source. '.repeat(18000), ['summary']);
  assert.equal(peak, 3);
  assert.equal(active, 0);
  assert.ok(overlap);
  assert.equal(result.summary.tldr, 'Done');
});

test('preparation failure waits for in-flight evidence work and never starts final writing', async () => {
  const { context } = generationContext();
  let inventoryFinished = false, finalStarted = false;
  context.PanoLearnAccuracy.collect = async (_, request) => {
    await request('INVENTORY', 'Source evidence', 'inventory');
    inventoryFinished = true;
    return null;
  };
  context.chrome.runtime.sendMessage = async request => {
    if (request.system === 'INVENTORY') {
      await new Promise(resolve => setTimeout(resolve, 10));
      return { text: '{}' };
    }
    if (request.format === 'study') finalStarted = true;
    return { error: 'Preparation failed' };
  };
  await assert.rejects(context.generate('Lecture source. '.repeat(10000), ['summary']), /Preparation failed/);
  assert.equal(inventoryFinished, true);
  assert.equal(finalStarted, false);
});

test('publication build requests only used permissions and exposes only the privacy page', () => {
  const manifest = JSON.parse(read('manifest.json'));
  assert.deepEqual(manifest.permissions, ['storage', 'identity']);
  assert.ok(!manifest.host_permissions.includes('https://api.openai.com/*'));
  assert.deepEqual(manifest.web_accessible_resources.flatMap(rule => rule.resources), ['privacy.html']);
  assert.ok(read('content.js').includes('Generate sends the selected transcript text and lecture titles through PanoLearn'));
  assert.ok(read('popup.html').includes('export your notes as PDF'));
  assert.ok(!read('popup.html').includes('PanoLearn v1.0.0'));
  assert.ok(read('privacy.html').includes('store: false'));
});

test('popup displays account status and signs out without exposing credentials', async () => {
  const events = {}, fields = {}, messages = [];
  for (const id of ['sign-in-btn', 'sign-out-btn', 'account-status', 'save-feedback', 'status-dot', 'extension-version']) {
    fields[id] = { classList: { toggle() {} }, addEventListener(type, fn) { events[id + ':' + type] = fn; } };
  }
  const context = vm.createContext({ document: { getElementById: id => fields[id] }, chrome: {
    runtime: { getManifest: () => ({ version: '1.9.0' }), sendMessage: async message => {
      messages.push(message.type);
      return { signedIn: message.type !== 'PL_SIGN_OUT', email: 'student@example.com' };
    } }
  } });
  vm.runInContext(read('popup.js'), context);
  await tick();
  assert.equal(fields['extension-version'].textContent, 'PanoLearn v1.9.0');
  assert.equal(fields['account-status'].textContent, 'Signed in as student@example.com');
  await events['sign-out-btn:click']();
  assert.equal(fields['account-status'].textContent, 'Sign in to generate study notes.');
  assert.deepEqual(messages, ['PL_AUTH_STATUS', 'PL_SIGN_OUT']);
  assert.ok(!read('popup.html').includes('api-key-input'));
});

test('page messages cannot sign in, sign out or retrieve account status', () => {
  const { listener } = backgroundContext();
  let replies = 0;
  for (const type of ['PL_SIGN_IN', 'PL_SIGN_OUT', 'PL_AUTH_STATUS']) {
    const result = listener({ type }, { id: 'extension', tab: { id: 1 }, frameId: 0, url: 'https://school.panopto.com/lecture' }, () => replies++);
    assert.equal(result, undefined);
  }
  assert.equal(replies, 0);
});
