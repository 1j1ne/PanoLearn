// panel-ui.js — Tiny virtual DOM renderer for PanoLearn result panels.
// Exposes window.PanoLearnUI.mount(rootEl, result) as the public API.
// No external dependencies — vanilla JS only.
(function () {
  'use strict';

  // ────────────────────────────────────────────────────────────────────────────
  // Virtual DOM core
  // ────────────────────────────────────────────────────────────────────────────

  /**
   * Create a virtual node.
   * @param {string} tag
   * @param {Object|null} props
   * @param {...any} children  — strings, numbers, vnodes, or arrays thereof
   * @returns {{ tag, props, children }}
   */
  function h(tag, props) {
    const children = [];
    for (let i = 2; i < arguments.length; i++) {
      const c = arguments[i];
      if (Array.isArray(c)) {
        for (let j = 0; j < c.length; j++) {
          if (c[j] != null && c[j] !== false) children.push(c[j]);
        }
      } else if (c != null && c !== false) {
        children.push(c);
      }
    }
    return { tag, props: props || {}, children };
  }

  /**
   * Turn a vnode into a real DOM node.
   * Special prop keys:
   *   className                 → el.className
   *   style (object)            → Object.assign(el.style, ...)
   *   onXxx (function)          → addEventListener
   *   dangerouslySetInnerHTML   → el.innerHTML = val.__html
   */
  function renderNode(vnode) {
    if (vnode == null || vnode === false) {
      return document.createTextNode('');
    }
    if (typeof vnode === 'string' || typeof vnode === 'number') {
      return document.createTextNode(String(vnode));
    }

    const el = document.createElement(vnode.tag);
    const props = vnode.props || {};
    let hasInnerHTML = false;

    for (const key in props) {
      if (!Object.prototype.hasOwnProperty.call(props, key)) continue;
      const val = props[key];

      if (key === 'dangerouslySetInnerHTML') {
        el.innerHTML = (val && val.__html != null) ? val.__html : '';
        hasInnerHTML = true;
      } else if (key === 'className') {
        el.className = val;
      } else if (key === 'style' && typeof val === 'object' && val !== null) {
        Object.assign(el.style, val);
      } else if (key.length > 2 && key[0] === 'o' && key[1] === 'n' && typeof val === 'function') {
        el.addEventListener(key.slice(2).toLowerCase(), val);
      } else if (val != null && val !== false) {
        el.setAttribute(key, String(val));
      }
    }

    if (!hasInnerHTML) {
      const kids = vnode.children || [];
      for (let i = 0; i < kids.length; i++) {
        el.appendChild(renderNode(kids[i]));
      }
    }

    return el;
  }

  // ────────────────────────────────────────────────────────────────────────────
  // Render scheduler
  // ────────────────────────────────────────────────────────────────────────────

  let _root = null;
  let _data = null;
  let _pending = false;

  function scheduleRender() {
    if (_pending) return;
    _pending = true;
    queueMicrotask(function () {
      _pending = false;
      if (_root && _data) {
        const newEl = renderNode(buildUI(_data));
        _root.innerHTML = '';
        _root.appendChild(newEl);
      }
    });
  }

  /**
   * Public entry point. Resets all component state and schedules a fresh render.
   * @param {HTMLElement} rootEl
   * @param {Object} result  — parsed JSON from Claude
   */
  let _options = {};
  function mount(rootEl, result, options = {}) {
    _options = options;
    _root = rootEl;
    _data = result;
    // Reset all interactive state so each new mount starts clean
    _openSections.clear();
    if (result.summary) _openSections.add('summary');
    _openConcepts.clear();
    _openTopics.clear();
    _flippedCards.clear();
    _revealedAnswers.clear();
    scheduleRender();
  }

  // ────────────────────────────────────────────────────────────────────────────
  // Component state stores  (module-level Sets, keyed by stable string IDs)
  // ────────────────────────────────────────────────────────────────────────────

  const _openSections    = new Set();
  const _openConcepts    = new Set();
  const _openTopics      = new Set();
  const _flippedCards    = new Set();
  const _revealedAnswers = new Set();

  function toggle(store, id) {
    store.has(id) ? store.delete(id) : store.add(id);
    scheduleRender();
  }

  // ────────────────────────────────────────────────────────────────────────────
  // Math / text helper
  // ────────────────────────────────────────────────────────────────────────────

  function escHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // Only rewrite a complete, unambiguous slash quotient inside math delimiters.
  // Do not guess precedence in a/b+c, a/b/c, prose, dates, URLs or code.
  function stackSimpleFraction(tex) {
    const script = String.raw`(?:[_^](?:\{[^{}]+\}|[A-Za-z0-9]))*`;
    const atom = String.raw`-?(?:\d+(?:\.\d+)?|[A-Za-z]${script}|d[A-Za-z]|\\partial\s+[A-Za-z]|\([^()/]+\)|\{[^{}\/]+\})`;
    const match = tex.trim().match(new RegExp('^(' + atom + ')\\s*/\\s*(' + atom + ')$'));
    return match ? '\\frac{' + match[1] + '}{' + match[2] + '}' : tex;
  }

  // JSON can legally decode an incorrectly escaped TeX prefix into a control
  // character (\frac -> form feed + rac). Repair only known command tails,
  // inside formula spans; ordinary prose, code and line breaks are untouched.
  function repairMathEscapes(tex) {
    return tex
      .replace(/\u000c(?=(?:rac|box)\b)/g, '\\f')
      .replace(/\u0008(?=(?:oldsymbol|old|igl|igr|ig|inom|egin)\b)/g, '\\b')
      .replace(/\r(?=(?:angle|ight|ho|oot|m)\b)/g, '\\r')
      .replace(/\t(?=(?:frac|imes|ext(?:bf|it|rm|sf|tt|normal)?|heta|au|an)\b)/g, '\\t')
      .replace(/\n(?=(?:abla|u|eq|otin)\b)/g, '\\n');
  }

  function stackFractions(tex) {
    // Split only top-level equality chains. Each quotient is grouped on its
    // own, leaving precedence in sums and nested expressions unchanged.
    const parts = [];
    let depth = 0, start = 0;
    for (let i = 0; i < tex.length; i++) {
      if ('({['.includes(tex[i])) depth++;
      if (')}]'.includes(tex[i])) depth--;
      if (tex[i] === '=' && depth === 0) {
        parts.push(stackSimpleFraction(tex.slice(start, i)));
        start = i + 1;
      }
    }
    parts.push(stackSimpleFraction(tex.slice(start)));
    return parts.join(' = ');
  }

  function renderFormula(tex, display = false) {
    tex = stackFractions(repairMathEscapes(tex));
    try {
      const rendered = katex.renderToString(tex, {
        displayMode: display, output: 'mathml', throwOnError: true,
        trust: false, strict: 'ignore', maxExpand: 1000, maxSize: 20
      });
      return '<span class="pl-equation' + (display ? ' pl-equation-block' : '') + '">' + rendered + '</span>';
    } catch (_) {
      return '<span class="pl-math-error" title="This formula could not be rendered. Regenerate the notes to retry.">' + escHtml(tex) + '</span>';
    }
  }

  // Recover unambiguous notation when generated prose omits math delimiters.
  // Protect URLs, code, paths, and multi-letter identifiers first. Never infer
  // subscripts from x0 or treat ordinary slash-separated dates as fractions.
  function proseWithMath(source) {
    const protectedText = /(`[^`]*`|https?:\/\/[^\s]+|\b[\w.-]+\/[\w./-]+|\b[A-Za-z][A-Za-z0-9]*_[A-Za-z0-9_]+\b)/g;
    const group = String.raw`\{[^{}\n]+\}`;
    const script = String.raw`(?:[_^](?:${group}|[+-]?\d+|[A-Za-z]{1,3}))*`;
    const variable = String.raw`[A-Za-z]${script}`;
    const fn = String.raw`[A-Za-z]\([A-Za-z0-9_,+\-\s]+\)${script}`;
    const paren = String.raw`\([A-Za-z0-9_{}^+\-\s]+\)${script}`;
    const command = String.raw`\\(?:frac|dfrac|tfrac|sqrt|vec|mathbf|mathrm|mathbb|overline|hat)(?:${group}){1,2}${script}`;
    const atom = String.raw`(?:${command}|${fn}|${paren}|${variable}|\d+(?:\.\d+)?)`;
    const notation = new RegExp(String.raw`(?<![\w\\/.])(?:∂[A-Za-z]\/∂[A-Za-z]|d[A-Za-z]\/d[A-Za-z]|${atom}(?:\s*[=+−*/-]\s*${atom})*)(?![\w/])`, 'g');
    function format(chunk) {
      return chunk.replace(notation, match => {
        // Bare single letters/numbers are prose. Only explicit mathematical
        // operators, scripts, function calls, or commands activate rendering.
        if (!/[_^=\\∂]|^[A-Za-z]\(|^d[A-Za-z]\/d[A-Za-z]$/.test(match)) return match;
        let tex = match.replace(/∂/g, '\\partial ');
        tex = tex.replace(/([_^])([A-Za-z]{2,3})(?![A-Za-z])/g, '$1{$2}');
        if (/^(?:∂[A-Za-z]\/∂[A-Za-z]|d[A-Za-z]\/d[A-Za-z])$/.test(match)) {
          const [numerator, denominator] = tex.split('/');
          tex = '\\frac{' + numerator + '}{' + denominator + '}';
        }
        return '\u0000' + formulas.push(renderFormula(tex)) + '\u0000';
      });
    }
    const formulas = [];
    const segments = source.split(protectedText);
    const result = segments.map((part, i) => {
      // Short f_x / f_xy and derivative ratios are math, not identifiers/paths.
      const isMath = /^[A-Za-z]_[A-Za-z0-9]{1,3}$/.test(part) || /^d[A-Za-z]\/d[A-Za-z]$/.test(part);
      return escHtml(i % 2 && !isMath ? part : format(part));
    }).join('');
    return result.replace(/\u0000(\d+)\u0000/g, (_, number) => formulas[Number(number) - 1] || '');
  }

  // KaTeX receives raw TeX, not HTML-escaped text: matrices need literal &.
  function mathHtml(text) {
    const source = String(text ?? '').replace(/\u0000/g, '');
    const delimiters = [['$$', '$$', true], ['\\[', '\\]', true], ['\\(', '\\)', false], ['$', '$', false]];
    const escaped = index => {
      let slashes = 0;
      while (index > 0 && source[--index] === '\\') slashes++;
      return slashes % 2 === 1;
    };
    let html = '', plainStart = 0, index = 0;
    while (index < source.length) {
      const delimiter = delimiters.find(([open]) => source.startsWith(open, index) && !escaped(index));
      if (!delimiter) { index++; continue; }
      const [open, close, display] = delimiter;
      const start = index + open.length;
      let end = source.indexOf(close, start);
      while (end !== -1 && escaped(end)) end = source.indexOf(close, end + close.length);
      const tex = end === -1 ? '' : repairMathEscapes(source.slice(start, end));
      // Accept padded formulas while leaving common currency pairs as prose.
      if (end === -1 || !tex.trim() || (open === '$' && (/\n/.test(tex) || (/^\s*\d/.test(tex) && /[A-Za-z]{2,}/.test(tex) && !/[_^=\\]/.test(tex))))) {
        index += open.length;
        continue;
      }
      html += proseWithMath(source.slice(plainStart, index));
      html += renderFormula(tex.trim(), display);
      index = end + close.length;
      plainStart = index;
    }
    return { __html: html + proseWithMath(source.slice(plainStart)) };
  }

  // ────────────────────────────────────────────────────────────────────────────
  // Components
  // ────────────────────────────────────────────────────────────────────────────

  /**
   * Top-level collapsible accordion section.
   */
  function Section(id, icon, label, count, colorClass, bodyChildren) {
    const open = _options.print || _openSections.has(id);
    return h('div', { className: 'pl-section pl-section--' + colorClass + (open ? ' pl-section--open' : '') },
      h('button', {
        className: 'pl-section-header',
        'aria-expanded': String(open),
        onClick: function () { toggle(_openSections, id); }
      },
        h('span', { className: 'pl-section-icon' }, icon),
        h('span', { className: 'pl-section-title' }, label),
        count != null
          ? h('span', { className: 'pl-section-badge' }, String(count))
          : null,
        h('span', { className: 'pl-section-chevron' }, '▾')
      ),
      h('div', { className: 'pl-section-body' }, bodyChildren)
    );
  }

  /**
   * Sub-accordion for a single 3-step concept (DEF / WHY / USE).
   */
  function ConceptItem(id, concept) {
    const open = _options.print || _openConcepts.has(id);
    return h('div', { className: 'pl-concept' + (open ? ' pl-concept--open' : '') },
      h('button', {
        className: 'pl-concept-header',
        'aria-expanded': String(open),
        onClick: function () { toggle(_openConcepts, id); }
      },
        h('span', { className: 'pl-concept-title', dangerouslySetInnerHTML: mathHtml(concept.title || '') }),
        h('span', { className: 'pl-concept-chevron' }, '▾')
      ),
      h('div', { className: 'pl-concept-body' },
        h('div', { className: 'pl-step' },
          h('span', { className: 'pl-step-badge pl-step-badge--def' }, 'DEF'),
          h('span', { className: 'pl-step-text', dangerouslySetInnerHTML: mathHtml(concept.step1_definition || '') })
        ),
        h('div', { className: 'pl-step' },
          h('span', { className: 'pl-step-badge pl-step-badge--why' }, 'WHY'),
          h('span', { className: 'pl-step-text', dangerouslySetInnerHTML: mathHtml(concept.step2_principle || '') })
        ),
        h('div', { className: 'pl-step' },
          h('span', { className: 'pl-step-badge pl-step-badge--use' }, 'USE'),
          h('span', { className: 'pl-step-text', dangerouslySetInnerHTML: mathHtml(concept.step3_application || '') })
        )
      )
    );
  }

  /**
   * Tap-to-flip flashcard.
   */
  function FlashItem(id, card) {
    const flipped = _flippedCards.has(id);
    return h('div', { className: 'pl-flashcard-wrapper' },
      h('div', {
        className: 'pl-flashcard' + (flipped ? ' pl-flashcard--flipped' : ''),
        onClick: function () { toggle(_flippedCards, id); },
        role: 'button',
        tabindex: '0',
        onKeydown: function (event) {
          if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); toggle(_flippedCards, id); }
        },
        'aria-label': flipped ? 'Flip flashcard to question' : 'Flip flashcard to answer'
      },
        h('div', { className: 'pl-flashcard-inner' },
          h('div', { className: 'pl-flashcard-front', dangerouslySetInnerHTML: mathHtml(card.front || '') }),
          h('div', { className: 'pl-flashcard-back',  dangerouslySetInnerHTML: mathHtml(card.back  || '') })
        )
      ),
      h('div', { className: 'pl-flashcard-hint' }, flipped ? 'tap to flip back' : 'tap to reveal answer')
    );
  }

  /**
   * Exam question with Show/Hide answer reveal.
   * Difficulty color-coded: easy=green, medium=gold, hard=orange.
   */
  function ExamItem(id, question) {
    const revealed = _options.print || _revealedAnswers.has(id);
    const diff = (question.difficulty || 'medium').toLowerCase();
    return h('div', { className: 'pl-exam-item' },
      h('div', { className: 'pl-exam-header' },
        h('span', { className: 'pl-exam-difficulty pl-exam-difficulty--' + diff }, diff.toUpperCase()),
        h('span', { className: 'pl-exam-type' }, question.type || '')
      ),
      h('div', { className: 'pl-exam-question', dangerouslySetInnerHTML: mathHtml(question.question || '') }),
      h('button', {
        className: 'pl-exam-reveal-btn',
        onClick: function (e) { e.stopPropagation(); toggle(_revealedAnswers, id); }
      }, revealed ? 'Hide Answer' : 'Show Answer'),
      revealed
        ? h('div', { className: 'pl-exam-answer pl-exam-answer--visible', dangerouslySetInnerHTML: mathHtml(question.answer || '') })
        : null
    );
  }

  /**
   * Single entry in a vertical timeline.
   */
  function SummaryReferences(references) {
    if (!references?.length) return null;
    const combined = _options.lectures?.length > 0;
    return h('div', { className: 'pl-summary-references' }, references.map(function (raw) {
      const ref = PanoLearnTranscript.timelineItem(raw);
      const lecture = _options.lectures?.find(lecture => lecture.id === ref.lecture_id);
      const href = ref.start_seconds !== null ? PanoLearnTranscript.videoLink(combined ? lecture?.pageUrl : _options.pageUrl, ref.start_seconds) : null;
      const label = (combined ? (lecture?.label || 'Unidentified lecture') + ' · ' : '') + ref.segment;
      const time = href ? h('a', { className: 'pl-timeline-segment pl-timeline-link', href,
        target: '_blank', rel: 'noopener noreferrer', 'aria-label': 'Go to ' + label,
        title: ref.timing_basis === 'timestamp' ? 'Transcript timestamp; starting quote could not be matched.' : 'Go to this transcript cue',
        onClick: function (event) {
          if (combined || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey || event.button !== 0 || !_options.onSeek) return;
          event.preventDefault();
          _options.onSeek(ref.start_seconds);
        }
      }, label) : h('span', { className: 'pl-timeline-segment' }, label);
      return ref.kind === 'example' ? h('div', { className: 'pl-worked-example' },
        h('strong', { dangerouslySetInnerHTML: mathHtml('Worked example: ' + (ref.label || 'Example problem')) }),
        time
      ) : time;
    }));
  }

  function TimelineItem(item) {
    const combined = _options.lectures?.length > 0;
    const lecture = _options.lectures?.find(lecture => lecture.id === item.lecture_id);
    const pageUrl = combined ? lecture?.pageUrl : _options.pageUrl;
    const href = Number.isFinite(item.start_seconds) && pageUrl
      ? PanoLearnTranscript.videoLink(pageUrl, item.start_seconds) : null;
    return h('div', { className: 'pl-timeline-item' },
      h('div', { className: 'pl-timeline-dot' }),
      combined ? h('div', { className: 'pl-lecture-help' }, lecture?.label || 'Unidentified lecture') : null,
      href ? h('a', { className: 'pl-timeline-segment pl-timeline-link', href,
        target: '_blank', rel: 'noopener noreferrer',
        'aria-label': 'Seek to ' + PanoLearnTranscript.formatTime(item.start_seconds),
        onClick: function (event) {
          if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey || event.button !== 0 || !_options.onSeek) return;
          event.preventDefault();
          _options.onSeek(item.start_seconds);
        }
      }, item.segment) : h('div', { className: 'pl-timeline-segment' }, item.segment || 'Time unavailable'),
      h('div', { className: 'pl-timeline-topic', dangerouslySetInnerHTML: mathHtml(item.topic || '') }),
      h('div', { className: 'pl-timeline-keypoint', dangerouslySetInnerHTML: mathHtml(item.key_point || '') })
    );
  }

  /**
   * One branch of the mind map with colored label and child chips.
   */
  function MindMapBranch(branch) {
    const color = /^(fire|forest|gold|ink)$/.test(branch.color) ? branch.color : 'ink';
    const children = Array.isArray(branch.children) ? branch.children : [];
    return h('div', { className: 'pl-mindmap-branch pl-branch--' + color },
      h('div', { className: 'pl-branch-label', dangerouslySetInnerHTML: mathHtml(branch.label || '') }),
      h('div', { className: 'pl-branch-children' },
        children.map(function (child) {
          return h('span', { className: 'pl-branch-chip', dangerouslySetInnerHTML: mathHtml(child) });
        })
      )
    );
  }

  // ────────────────────────────────────────────────────────────────────────────
  // Top-level UI builder
  // ────────────────────────────────────────────────────────────────────────────

  function buildUI(result) {
    const sections = [];

    // Scope note
    if (result.scope_note) {
      sections.push(h('div', { className: 'pl-scope-note', dangerouslySetInnerHTML: mathHtml(result.scope_note) }));
    }

    // Summary
    const s = result.summary;
    if (s && (s.tldr || s.main_topics?.length || s.worked_examples?.length || s.what_to_remember)) {
      const body = [];
      const grouped = PanoLearnTranscript.groupExamples(s);
      if (s.tldr) {
        body.push(h('div', { className: 'pl-tldr', dangerouslySetInnerHTML: mathHtml(s.tldr) }));
      }
      if (s.main_topics && s.main_topics.length) {
        body.push(h('ol', { className: 'pl-summary-outline' },
          s.main_topics.map(function (topic, index) {
            const key = 'topic-' + index;
            const title = h('strong', { dangerouslySetInnerHTML: mathHtml(typeof topic === 'string' ? topic : topic.title) });
            return h('li', {},
              h('details', { className: 'pl-topic-details', open: !!_options.print || _openTopics.has(key),
                onToggle: function (event) {
                  if (event.currentTarget.open) _openTopics.add(key);
                  else _openTopics.delete(key);
                }
              },
                h('summary', { className: 'pl-topic-toggle' }, title),
                typeof topic === 'string' ? null : SummaryReferences(topic.references),
                typeof topic === 'string' ? null : h('p', { dangerouslySetInnerHTML: mathHtml(topic.explanation) }),
                SummaryReferences(grouped.groups[index].map(example => ({ ...example, kind: 'example' })))
              )
            );
          })
        ));
      }
      if (grouped.unassigned.length) {
        body.push(h('div', { className: 'pl-worked-examples' },
          h('h3', {}, 'Worked examples'),
          SummaryReferences(grouped.unassigned.map(example => ({ ...example, kind: 'example' })))
        ));
      }
      if (s.table) {
        body.push(h('div', { className: 'pl-summary-table-wrap', tabindex: '0', role: 'region', 'aria-label': s.table.caption },
          h('table', { className: 'pl-summary-table' },
            h('caption', { dangerouslySetInnerHTML: mathHtml(s.table.caption) }),
            h('thead', {}, h('tr', {}, s.table.columns.map(function (cell) {
              return h('th', { scope: 'col', dangerouslySetInnerHTML: mathHtml(cell) });
            }))),
            h('tbody', {}, s.table.rows.map(function (row) {
              return h('tr', {}, row.map(function (cell) { return h('td', { dangerouslySetInnerHTML: mathHtml(cell) }); }));
            }))
          )
        ));
      }
      if (s.what_to_remember) {
        body.push(h('div', { className: 'pl-remember', dangerouslySetInnerHTML: mathHtml(s.what_to_remember) }));
      }
      sections.push(Section('summary', '📋', 'Summary', null, 'summary', body));
    }

    // 3-Step Concepts
    if (Array.isArray(result.concepts_3step) && result.concepts_3step.length) {
      const items = result.concepts_3step.map(function (c, i) {
        return ConceptItem('concept-' + i, c);
      });
      sections.push(Section('concepts', '🧠', '3-Step Concepts', result.concepts_3step.length, 'concepts', items));
    }

    // Flashcards
    if (Array.isArray(result.flashcards) && result.flashcards.length) {
      const items = result.flashcards.map(function (card, i) {
        return FlashItem('flash-' + i, card);
      });
      sections.push(Section('flashcards', '🃏', 'Flashcards', result.flashcards.length, 'flashcards', items));
    }

    // Timeline
    if (Array.isArray(result.timeline) && result.timeline.length) {
      const timelineEl = h('div', { className: 'pl-timeline' },
        result.timeline.map(function (item) { return TimelineItem(item); })
      );
      sections.push(Section('timeline', '📅', 'Timeline', result.timeline.length, 'timeline', [timelineEl]));
    }

    // Mind Map
    const mm = result.mindmap;
    if (mm && Array.isArray(mm.branches) && mm.branches.length) {
      const body = [h('div', { className: 'pl-mindmap-center', dangerouslySetInnerHTML: mathHtml(mm.center || 'Central Topic') })];
      mm.branches.forEach(function (b) { body.push(MindMapBranch(b)); });
      sections.push(Section('mindmap', '🗺️', 'Mind Map', null, 'mindmap', body));
    }

    // Exam Questions
    if (Array.isArray(result.exam_questions) && result.exam_questions.length) {
      const items = result.exam_questions.map(function (q, i) {
        return ExamItem('exam-' + i, q);
      });
      sections.push(Section('exam', '📝', 'Exam Questions', result.exam_questions.length, 'exam', items));
    }

    if (sections.length === 0) {
      sections.push(h('div', { className: 'pl-scope-note' }, 'No content to display. Try generating again with different sections selected.'));
    }

    return h('div', { className: 'pl-ui-root' }, sections);
  }

  // ────────────────────────────────────────────────────────────────────────────
  // Public API
  // ────────────────────────────────────────────────────────────────────────────

  window.PanoLearnUI = { mount: mount };
})();
