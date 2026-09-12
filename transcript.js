// Pure helpers shared by the extension and regression tests.
(function (root) {
  'use strict';
  function clean(text) {
    return String(text).replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim();
  }
  function normalize(payload) {
    if (typeof payload !== 'string' || !payload.trim()) return '';
    const raw = payload.trim();
    if (/^[{\[]/.test(raw)) {
      try {
        const lines = [];
        function visit(value) {
          if (Array.isArray(value)) return value.forEach(visit);
          if (!value || typeof value !== 'object') return;
          const text = value.Caption ?? value.caption ?? value.Text ?? value.text ?? value.Transcript ?? value.transcript;
          if (typeof text === 'string' && clean(text)) {
            const time = value.Time ?? value.time ?? value.StartTime ?? value.startTime ?? value.start;
            const seconds = parseTime(time);
            lines.push((seconds != null ? '[' + formatTime(seconds) + (seconds % 1 ? String(seconds).slice(String(seconds).indexOf('.')) : '') + '] ' : '') + clean(text));
          } else Object.values(value).forEach(visit);
        }
        visit(JSON.parse(raw));
        return lines.join('\n');
      } catch (_) {
        // Plain transcripts often begin with a bracketed timestamp.
        if (!/^\[\d+(?::\d+)*(?:\.\d+)?\]/.test(raw)) return '';
      }
    }
    if (/^\s*<(?:!doctype|html|\?xml)/i.test(raw)) return '';
    return raw.split(/\r?\n\s*\r?\n/).filter(block => !/^(NOTE|STYLE|REGION)\b/.test(block.trim()))
      .map(block => block.split(/\r?\n/).filter(line => !/^WEBVTT\b|^Kind:|^Language:/.test(line))
        .filter((line, i, all) => !(all[i + 1]?.includes('-->') && !line.includes('-->')))
        .map(clean).filter(Boolean).join('\n')).filter(Boolean).join('\n\n');
  }
  function chunks(text, limit = 14000) {
    const result = [];
    let rest = text;
    while (rest.length > limit) {
      let end = rest.lastIndexOf('\n', limit);
      if (end < limit / 2) end = rest.lastIndexOf(' ', limit);
      if (end < limit / 2) end = limit;
      result.push(rest.slice(0, end));
      rest = rest.slice(end);
    }
    if (rest) result.push(rest);
    return result;
  }
  function readPanoptoCaptions(doc) {
    // Read transcript rows, never slides, discussion, search results or the current subtitle overlay.
    const rows = doc.querySelectorAll('.event-tab-list li[id^="UserCreatedTranscript-"]');
    const lines = [];
    for (const row of rows) {
      const caption = row.querySelector('.event-text');
      const time = row.querySelector('.event-time')?.textContent.trim();
      if (!caption || !/^\d+(?::\d{2}){1,2}$/.test(time || '')) continue;
      // innerText preserves line breaks in Panopto's caption spans / <br> tags.
      const text = (caption.innerText || caption.textContent || '').replace(/\s+/g, ' ').trim();
      if (text) lines.push('[' + time + '] ' + text);
    }
    return lines.join('\n');
  }
  function cues(text) {
    const result = [];
    let current = null;
    for (const line of text.split(/\r?\n/)) {
      const bracket = line.match(/^\s*\[(\d+(?::\d{2}){1,2}(?:\.\d+)?)\]\s*(.*)$/);
      const subtitle = line.match(/^\s*(\d+(?::\d{2}){1,2}[.,]\d+)\s*-->\s*(\d+(?::\d{2}){1,2}[.,]\d+)/);
      if (bracket || subtitle) {
        const start = parseTime((bracket?.[1] || subtitle[1]).replace(',', '.'));
        current = start === null ? null : { start, text: bracket?.[2] || '' };
        if (current) {
          if (subtitle) {
            const end = parseTime(subtitle[2].replace(',', '.'));
            if (end !== null && end >= start) current.end = end;
          }
          result.push(current);
        }
      } else if (current && line.trim()) current.text += ' ' + line.trim();
    }
    return result;
  }

  function groupExamples(summary) {
    const topics = summary.main_topics || [];
    const groups = topics.map(() => []);
    const unassigned = [];
    for (const example of summary.worked_examples || []) {
      const index = topics.findIndex((topic, i) => example.topic_id === (topic.id || 'T' + (i + 1)));
      if (index >= 0) groups[index].push(example);
      else if (topics.length === 1) groups[0].push(example);
      else unassigned.push(example);
    }
    return { groups, unassigned };
  }

  function indexedTranscript(text, lectureId) {
    let index = 0;
    return text.split(/\r?\n/).map(line => {
      if (/^\s*\[\d+(?::\d{2}){1,2}(?:\.\d+)?\]/.test(line) || /^\s*\d+(?::\d{2}){1,2}[.,]\d+\s*-->/.test(line)) {
        return '[' + lectureId + ':C' + (++index) + '] ' + line;
      }
      return line;
    }).join('\n');
  }

  // Prefer transcript evidence, but do not erase an actual cue timestamp just
  // because the model paraphrased its quote. Captions often split sentences.
  function groundReferences(result, lectures) {
    const normalizeQuote = text => String(text || '').normalize('NFKC').toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
    const sources = new Map(lectures.map(lecture => [lecture.id, cues(lecture.text)]));
    const groups = [...(result.summary?.main_topics || []), { references: result.summary?.worked_examples || [] }];
    for (const topic of groups) {
      if (typeof topic === 'string') continue;
      topic.references = (topic.references || []).map(ref => {
        if (ref.boundary_status === 'unconfirmed') return timelineItem({ ...ref, start_seconds: null, end_seconds: null, segment: 'Timing not confirmed' });
        const lectureId = ref.lecture_id || (lectures.length === 1 ? lectures[0].id : '');
        const cueMatch = typeof ref.cue_id === 'string' ? ref.cue_id.match(/^(L\d+):C([1-9]\d*)$/) : null;
        const resolvedId = cueMatch?.[1] || lectureId;
        const source = sources.get(resolvedId) || [];
        const indexedCue = cueMatch ? source[Number(cueMatch[2]) - 1] : null;
        const quote = normalizeQuote(ref.source_quote);
        const matches = !indexedCue && quote.length >= 8 ? source.filter((cue, i) => {
          const first = normalizeQuote(cue.text);
          const combined = normalizeQuote(source.slice(i, i + 6).map(item => item.text).join(' '));
          const offset = combined.indexOf(quote);
          return offset >= 0 && offset < first.length;
        }) : [];
        const quotedCue = matches.find(cue => cue.start === ref.start_seconds) || (matches.length === 1 ? matches[0] : null);
        const timestampCue = !indexedCue && !quotedCue ? source.find(cue => cue.start === ref.start_seconds) : null;
        const cue = indexedCue || quotedCue || timestampCue;
        const endMatch = typeof ref.end_cue_id === 'string' ? ref.end_cue_id.match(/^(L\d+):C([1-9]\d*)$/) : null;
        const indexedEnd = endMatch?.[1] === resolvedId ? source[Number(endMatch[2]) - 1] : null;
        const proposedEnd = indexedEnd?.start ?? ref.end_seconds;
        const end = cue && source.some(item => (item.start === proposedEnd || item.end === proposedEnd) && proposedEnd >= cue.start) ? proposedEnd : null;
        return timelineItem({ ...ref, lecture_id: resolvedId, start_seconds: cue?.start ?? null, end_seconds: end,
          segment: cue ? undefined : source.length ? 'Timestamp not found in transcript' : 'Transcript has no timestamps', verified: !!(indexedCue || quotedCue),
          timing_basis: indexedCue ? 'cue_id' : quotedCue ? 'quote' : timestampCue ? 'timestamp' : 'unavailable' });
      });
    }
    // One topic has one primary span. Worked examples retain their own spans.
    for (const topic of result.summary?.main_topics || []) {
      if (typeof topic === 'string') continue;
      const primary = topic.references.find(ref => ref.start_seconds !== null && ref.end_seconds !== null)
        || topic.references.find(ref => ref.start_seconds !== null) || topic.references[0];
      topic.references = primary ? [primary] : [];
    }
    if (result.summary) result.summary.worked_examples = groups[groups.length - 1].references;
    return result;
  }

  function parseTime(value) {
    if (typeof value === 'number') return Number.isFinite(value) && value >= 0 ? value : null;
    if (typeof value !== 'string') return null;
    const text = value.trim();
    if (/^\d+(?:\.\d+)?$/.test(text)) return Number(text);
    if (!/^\d+(?::[0-5]\d){1,2}(?:\.\d+)?$/.test(text)) return null;
    return text.split(':').reduce((total, part) => total * 60 + Number(part), 0);
  }
  function formatTime(seconds) {
    const whole = Math.floor(seconds);
    return Math.floor(whole / 60) + ':' + String(whole % 60).padStart(2, '0');
  }
  function timelineItem(item) {
    // New output uses numeric seconds; formatting is owned by the extension.
    const start = typeof item.start_seconds === 'number' ? parseTime(item.start_seconds) : null;
    const end = typeof item.end_seconds === 'number' ? parseTime(item.end_seconds) : null;
    if (start === null || (end !== null && end < start)) {
      return { ...item, start_seconds: null, end_seconds: null, segment: item.segment || 'Time unavailable' };
    }
    return { ...item, start_seconds: start, end_seconds: end,
      segment: formatTime(start) + (end !== null ? ' ~ ' + formatTime(end) : '') };
  }
  function videoLink(pageUrl, seconds) {
    try {
      const url = new URL(pageUrl);
      if (url.protocol !== 'https:' || !/(^|\.)panopto\.com$/i.test(url.hostname) || !url.searchParams.has('id')) return null;
      url.pathname = '/Panopto/Pages/Viewer.aspx';
      url.searchParams.set('start', String(seconds));
      return url.href;
    } catch (_) { return null; }
  }
  root.PanoLearnTranscript = { groupExamples, indexedTranscript, cues, groundReferences, normalize, chunks, readPanoptoCaptions, parseTime, formatTime, timelineItem, videoLink };
})(globalThis);
