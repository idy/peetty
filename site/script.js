"use strict";

(() => {
  const STORAGE_KEY = "peetty-figure";
  const pickerButtons = document.querySelectorAll("button[data-figure]");
  const presets = Array.from(pickerButtons, (button) => button.dataset.figure);
  const read = () => {
    try { return localStorage.getItem(STORAGE_KEY); } catch { return null; }
  };
  const save = (value) => {
    try { localStorage.setItem(STORAGE_KEY, value); } catch { /* Works for this visit only. */ }
  };
  const savedFigure = read();
  let figure = presets.includes(savedFigure) ? savedFigure : "miru";
  let pet = null;
  let language = IdySite.language;

  function syncPicker() {
    for (const button of pickerButtons) {
      button.setAttribute("aria-pressed", String(button.dataset.figure === figure));
    }
  }

  function syncPlaceholder() {
    for (const input of document.querySelectorAll("[data-i18n-placeholder]")) {
      input.placeholder = IdySite.t(input.dataset.i18nPlaceholder);
    }
  }

  function start() {
    if (!window.Peetty?.createPeetty) return;
    pet = window.Peetty.createPeetty({ figure, language });
    window.peetty = pet;
    pet.mount().catch((error) => console.error("[peetty]", error));
  }

  for (const button of pickerButtons) {
    button.addEventListener("click", () => {
      figure = button.dataset.figure;
      save(figure);
      syncPicker();
      if (!pet) return;
      pet.show();
      pet.setFigure(figure).then(() => pet.play("wave")).catch((error) => console.error("[peetty]", error));
    });
  }

  document.addEventListener("idy:languagechange", () => {
    syncPlaceholder();
    if (IdySite.language === language) return;
    language = IdySite.language;
    pet?.setLanguage(language);
  });

  for (const button of document.querySelectorAll('[data-peetty-chat]')) {
    button.addEventListener('click', () => {
      if (!pet) start();
      if (pet) { pet.show(); void pet.openChat(); }
    });
  }

  syncPicker();
  syncPlaceholder();
  start();
})();
