// Classic script in <head>: hide the page for the moment it takes to apply a
// stored interface language, so Chinese copy never flashes first.
(() => {
  try {
    const locale = localStorage.getItem('folio.locale');
    if (locale !== 'en' && locale !== 'ja') return;
    const root = document.documentElement;
    root.lang = locale;
    root.setAttribute('data-i18n-pending', '');
    setTimeout(() => root.removeAttribute('data-i18n-pending'), 2500);
  } catch {}
})();
