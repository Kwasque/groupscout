/*
 * GroupScout — listes déroulantes personnalisées
 *
 * enhanceSelect(select) garde le <select> natif (caché) comme source de vérité :
 * le reste du code continue d'utiliser select.value, select.disabled, select.innerHTML
 * et l'événement "change". La liste s'ouvre dans un panneau posé sur <body> (position fixed),
 * pour ne pas être coupée ni passer sous les panneaux en verre.
 *
 * <select multiple> : une case à cocher par ligne, un clic coche ou décoche sans fermer la liste,
 * et le bouton résume le choix (« Aucun », le nom si un seul, sinon « 3 boss » avec
 * data-count-label="boss"). Le code lit select.selectedOptions.
 */
(function () {
  'use strict';

  const CHEVRON = '<svg class="kselect-chevron" viewBox="0 0 12 12" aria-hidden="true"><path d="M3 4.5 6 7.5 9 4.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const CHECK = '<svg class="kselect-check" viewBox="0 0 12 12" aria-hidden="true"><path d="M2.5 6.2 5 8.6 9.6 3.6" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  let uid = 0;
  let current = null;   // liste ouverte : { close }

  function enhanceSelect(select) {
    if (select.dataset.enhanced) return;
    select.dataset.enhanced = '1';
    const id = `kselect-${++uid}`;
    const multi = select.multiple;

    const wrap = document.createElement('div');
    wrap.className = 'kselect';
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'kselect-button';
    button.setAttribute('aria-haspopup', 'listbox');
    button.setAttribute('aria-expanded', 'false');
    button.innerHTML = `<span class="kselect-label"></span>${CHEVRON}`;
    select.parentNode.insertBefore(wrap, select);
    wrap.appendChild(button);
    wrap.appendChild(select);
    select.classList.add('kselect-native');
    select.tabIndex = -1;
    select.setAttribute('aria-hidden', 'true');

    // Libellé accessible : texte du <label> parent
    const labelText = select.closest('label')?.querySelector('span')?.textContent;
    if (labelText) button.setAttribute('aria-label', labelText);

    const pop = document.createElement('div');
    pop.className = 'kselect-pop';
    pop.id = id;
    pop.setAttribute('role', 'listbox');
    if (multi) { pop.setAttribute('aria-multiselectable', 'true'); pop.classList.add('is-multi'); }
    pop.hidden = true;
    document.body.appendChild(pop);
    button.setAttribute('aria-controls', id);

    const proto = HTMLSelectElement.prototype;
    const valueDesc = Object.getOwnPropertyDescriptor(proto, 'value');
    const indexDesc = Object.getOwnPropertyDescriptor(proto, 'selectedIndex');
    const disabledDesc = Object.getOwnPropertyDescriptor(proto, 'disabled');
    let active = -1;
    let typed = '';
    let typedTimer = null;

    const options = () => [...select.options];

    function summary() {
      if (!multi) return select.options[indexDesc.get.call(select)]?.textContent || '';
      const chosen = [...select.selectedOptions];
      if (!chosen.length) return select.dataset.empty || '—';
      if (chosen.length === 1) return chosen[0].textContent;
      // data-count-label : « {n, plural, one {# boss} other {# boss}} », déjà traduit avec la page
      const pattern = select.dataset.countLabel || '{n}';
      return window.GroupScoutI18n ? window.GroupScoutI18n.format(pattern, { n: chosen.length }, window.LANG) : pattern.replace('{n}', chosen.length);
    }

    function update() {
      const label = button.querySelector('.kselect-label');
      label.textContent = summary();
      label.classList.toggle('is-empty', multi && !select.selectedOptions.length);
      if (multi) button.title = [...select.selectedOptions].map((o) => o.textContent).join(', ');
      button.disabled = disabledDesc.get.call(select);
      wrap.classList.toggle('is-disabled', button.disabled);
      if (!pop.hidden) renderOptions();
    }

    // Les changements faits par le code (value, selectedIndex, disabled, options) mettent le bouton à jour
    Object.defineProperty(select, 'value', {
      configurable: true,
      get() { return valueDesc.get.call(this); },
      set(v) { valueDesc.set.call(this, v); update(); },
    });
    Object.defineProperty(select, 'selectedIndex', {
      configurable: true,
      get() { return indexDesc.get.call(this); },
      set(v) { indexDesc.set.call(this, v); update(); },
    });
    Object.defineProperty(select, 'disabled', {
      configurable: true,
      get() { return disabledDesc.get.call(this); },
      set(v) { disabledDesc.set.call(this, v); update(); },
    });
    new MutationObserver(update).observe(select, { childList: true, subtree: true, attributes: true, attributeFilter: ['disabled'] });

    function renderOptions() {
      const selected = indexDesc.get.call(select);
      const isOn = (o, i) => (multi ? o.selected : i === selected);
      pop.innerHTML = options().map((o, i) => `
        <div class="kselect-opt${isOn(o, i) ? ' is-selected' : ''}${i === active ? ' is-active' : ''}${o.disabled ? ' is-disabled' : ''}"
          id="${id}-${i}" role="option" data-index="${i}" aria-selected="${isOn(o, i)}">
          ${multi ? `<span class="kselect-box">${CHECK}</span>` : ''}<span class="kselect-opt-label"></span>${multi ? '' : CHECK}
        </div>`).join('');
      // textContent : les libellés viennent de données externes (noms de raids, de boss…)
      pop.querySelectorAll('.kselect-opt-label').forEach((el, i) => { el.textContent = options()[i].textContent; });
      if (active >= 0) {
        button.setAttribute('aria-activedescendant', `${id}-${active}`);
        pop.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' });
      } else {
        button.removeAttribute('aria-activedescendant');
      }
    }

    // La liste reste toujours dans la fenêtre (sinon sa barre de défilement se retrouve hors écran),
    // même si le bouton est au bord ou déjà sorti de la zone visible.
    function place() {
      const MARGIN = 8;
      const MIN_HEIGHT = 120;
      const MAX_HEIGHT = 320;
      // clientWidth / clientHeight : sans la barre de défilement de la page
      const vw = document.documentElement.clientWidth;
      const vh = document.documentElement.clientHeight;
      const r = button.getBoundingClientRect();

      pop.style.minWidth = `${Math.max(r.width, 140)}px`;
      pop.style.maxHeight = '';
      const want = Math.min(pop.scrollHeight, MAX_HEIGHT);
      // Place visible sous et au-dessus du bouton, bornée à la fenêtre
      const below = vh - Math.min(Math.max(r.bottom, 0), vh) - MARGIN;
      const above = Math.min(Math.max(r.top, 0), vh) - MARGIN;
      const openBelow = below >= want || below >= above;
      const room = Math.max(openBelow ? below : above, MIN_HEIGHT);
      const height = Math.min(want, room, vh - 2 * MARGIN);
      pop.style.maxHeight = `${height}px`;
      pop.classList.toggle('is-above', !openBelow);

      const wanted = openBelow ? r.bottom + 6 : r.top - 6 - height;
      const top = Math.min(Math.max(wanted, MARGIN), Math.max(MARGIN, vh - height - MARGIN));
      pop.style.top = `${top}px`;
      pop.style.left = `${Math.max(MARGIN, Math.min(r.left, vw - pop.offsetWidth - MARGIN))}px`;
    }

    function open() {
      if (button.disabled || !pop.hidden) return;
      current?.close();
      active = multi ? Math.max(0, options().findIndex((o) => o.selected)) : indexDesc.get.call(select);
      pop.hidden = false;
      renderOptions();
      place();
      button.setAttribute('aria-expanded', 'true');
      wrap.classList.add('is-open');
      current = { close, pop };
    }

    function close() {
      if (pop.hidden) return;
      pop.hidden = true;
      button.setAttribute('aria-expanded', 'false');
      button.removeAttribute('aria-activedescendant');
      wrap.classList.remove('is-open');
      if (current?.pop === pop) current = null;
    }

    function choose(index) {
      const opt = select.options[index];
      if (!opt || opt.disabled) return;
      // Choix multiple : on coche ou décoche, et la liste reste ouverte
      if (multi) {
        opt.selected = !opt.selected;
        active = index;
        update();
        renderOptions();
        select.dispatchEvent(new Event('change', { bubbles: true }));
        return;
      }
      const changed = indexDesc.get.call(select) !== index;
      indexDesc.set.call(select, index);
      update();
      close();
      button.focus();
      if (changed) select.dispatchEvent(new Event('change', { bubbles: true }));
    }

    function move(delta) {
      const opts = options();
      if (!opts.length) return;
      let i = active;
      for (let n = 0; n < opts.length; n++) {
        i = (i + delta + opts.length) % opts.length;
        if (!opts[i].disabled) break;
      }
      active = i;
      renderOptions();
    }

    button.addEventListener('click', () => (pop.hidden ? open() : close()));
    button.addEventListener('keydown', (ev) => {
      const isOpen = !pop.hidden;
      switch (ev.key) {
        case 'ArrowDown':
        case 'ArrowUp':
          ev.preventDefault();
          if (!isOpen) open(); else move(ev.key === 'ArrowDown' ? 1 : -1);
          return;
        case 'Home':
        case 'End':
          if (!isOpen) return;
          ev.preventDefault();
          active = ev.key === 'Home' ? -1 : options().length;
          move(ev.key === 'Home' ? 1 : -1);
          return;
        case 'Enter':
        case ' ':
          ev.preventDefault();
          if (isOpen && active >= 0) choose(active); else open();
          return;
        case 'Escape':
          if (isOpen) { ev.preventDefault(); close(); }
          return;
        case 'Tab':
          close();
          return;
        default:
          // Recherche en tapant les premières lettres
          if (ev.key.length !== 1 || ev.ctrlKey || ev.metaKey || ev.altKey) return;
          typed += ev.key.toLowerCase();
          clearTimeout(typedTimer);
          typedTimer = setTimeout(() => { typed = ''; }, 700);
          const found = options().findIndex((o) => !o.disabled && o.textContent.trim().toLowerCase().startsWith(typed));
          if (found < 0) return;
          if (isOpen) { active = found; renderOptions(); } else if (multi) { open(); active = found; renderOptions(); } else choose(found);
      }
    });
    pop.addEventListener('mousedown', (ev) => ev.preventDefault());   // garde le focus sur le bouton
    pop.addEventListener('click', (ev) => {
      const opt = ev.target.closest('.kselect-opt');
      if (opt) choose(Number(opt.dataset.index));
    });
    pop.addEventListener('mousemove', (ev) => {
      const opt = ev.target.closest('.kselect-opt');
      if (!opt || Number(opt.dataset.index) === active) return;
      active = Number(opt.dataset.index);
      pop.querySelectorAll('.kselect-opt').forEach((el) => el.classList.toggle('is-active', Number(el.dataset.index) === active));
    });
    // Clic sur le libellé du champ : ouvre la liste
    select.closest('label')?.addEventListener('click', (ev) => {
      if (ev.target.closest('.kselect')) return;
      ev.preventDefault();
      button.focus();
      open();
    });

    update();
  }

  // Fermeture : clic ailleurs, défilement de la page, redimensionnement
  document.addEventListener('pointerdown', (ev) => {
    if (current && !ev.target.closest('.kselect-pop') && !ev.target.closest('.kselect.is-open')) current.close();
  });
  window.addEventListener('scroll', (ev) => {
    if (current && !(ev.target instanceof Element && ev.target.closest('.kselect-pop'))) current.close();
  }, true);
  window.addEventListener('resize', () => current?.close());

  window.enhanceSelect = enhanceSelect;
})();
