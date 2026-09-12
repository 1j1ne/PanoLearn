// Keep transport schemas in the worker; page scripts select a known format,
// never supply arbitrary schema objects. Presentation uses the existing fields.
function studyResponseFormat(name) {
  if (name == null) return undefined;
  if (!['inventory', 'study', 'timing'].includes(name)) throw new Error('Invalid response format.');
  const string = { type: 'string' };
  const numberOrNull = { type: ['number', 'null'] };
  const array = items => ({ type: 'array', items });
  const object = properties => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
  const nullable = schema => ({ anyOf: [schema, { type: 'null' }] });
  const evidence = {
    note: string, start_id: string, last_id: string, start_quote: string,
    last_quote: string, complete: { type: 'boolean' }
  };
  const reference = {
    cue_id: string, end_cue_id: string, lecture_id: string, kind: string,
    label: string, note: string, source_quote: string,
    start_seconds: numberOrNull, end_seconds: numberOrNull
  };
  const schema = name === 'timing' ? object({ ranges: array(object({ id: string, start_id: string, last_id: string })) }) : name === 'inventory' ? object({
    topics: array(object({ title: string, ...evidence,
      examples: array(object({ label: string, ...evidence, method_quote: string }))
    }))
  }) : object({
    scope_note: string,
    summary: nullable(object({
      tldr: string,
      main_topics: array(object({ id: string, title: string, explanation: string, references: array(object(reference)) })),
      worked_examples: array(object({ topic_id: string, ...reference })),
      table: nullable(object({ caption: string, columns: array(string), rows: array(array(string)) })),
      what_to_remember: string
    })),
    concepts_3step: array(object({ title: string, step1_definition: string, step2_principle: string, step3_application: string })),
    flashcards: array(object({ front: string, back: string })),
    mindmap: nullable(object({ center: string, branches: array(object({ label: string, color: string, children: array(string) })) })),
    exam_questions: array(object({ type: string, difficulty: string, question: string, answer: string }))
  });
  return { type: 'json_schema', name: 'panolearn_' + name, strict: true, schema };
}

if (typeof module !== "undefined") module.exports = { studyResponseFormat };
