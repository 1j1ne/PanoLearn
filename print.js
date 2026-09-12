(async function () {
  'use strict';
  const status = document.getElementById('print-status');
  const button = document.getElementById('print-button');
  button.addEventListener('click', () => window.print());
  try {
    const key = decodeURIComponent(location.hash.slice(1));
    if (!key.startsWith('plPdf:')) throw new Error('Open PDF export from your lecture notes.');
    const data = (await chrome.storage.session.get(key))[key];
    if (!data?.result) throw new Error('This export has expired. Open Save Notes as PDF again.');
    await chrome.storage.session.remove(key);
    document.title = 'PanoLearn_Notes_' + new Date().toISOString().slice(0, 10);
    document.getElementById('print-sources').textContent = (data.lectures || []).map(lecture => lecture.label).join(' · ');
    PanoLearnUI.mount(document.getElementById('print-notes'), data.result, { print: true, pageUrl: data.pageUrl, lectures: data.lectures });
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    await document.fonts.ready;
    button.disabled = false;
    status.textContent = 'Choose “Save as PDF” as the destination in the print dialog.';
    window.print();
  } catch (error) { status.textContent = error.message; }
})();
