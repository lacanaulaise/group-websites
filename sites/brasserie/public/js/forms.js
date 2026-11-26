// Site forms (newsletter, visit booking, event quote, trade enquiry, shop order): post to the Worker,
// which relays to the "Demandes sites web" Apps Script. Messages come from the form's data-* attributes.
document.querySelectorAll('form[data-form]').forEach((form) => {
  form.addEventListener('submit', (ev) => {
    ev.preventDefault();
    const status = form.querySelector('.form-status');
    const btn = form.querySelector('button[type=submit]');
    const label = btn.textContent;
    btn.disabled = true;
    if (form.dataset.sending) btn.textContent = form.dataset.sending;
    fetch(form.getAttribute('action'), { method: 'POST', body: new FormData(form) })
      .then((r) => r.json())
      .then((d) => {
        status.textContent = d.ok ? form.dataset.ok : (d.error === 'email' && form.dataset.bad ? form.dataset.bad : form.dataset.fail);
        if (d.ok) form.reset();
      })
      .catch(() => { status.textContent = form.dataset.fail; })
      .finally(() => { btn.disabled = false; btn.textContent = label; });
  });
});
