/* =========================================================
   navbar.js — Survivor Train
   Gestione menu hamburger (mobile)
   Richiede markup:
     <header class="nav">
       ...
       <button class="hamburger" aria-controls="mobileMenu" aria-expanded="false">...
       <nav class="mobile-menu" id="mobileMenu">...
   ========================================================= */

(function () {
  "use strict";

  function setupNavbar() {
    const hamburger = document.querySelector(".hamburger");
    const mobileMenu = document.querySelector(".mobile-menu");
    const nav = document.querySelector(".nav");

    // Se la pagina non ha la navbar standard, esci senza errori
    if (!hamburger || !mobileMenu || !nav) return;

    // Assicurati che il dropdown sia posizionato rispetto alla navbar
    // (serve se la pagina non ha position:relative sul header)
    if (getComputedStyle(nav).position === "static") {
      nav.style.position = "relative";
    }

    function openMenu() {
      mobileMenu.classList.add("is-open");
      hamburger.setAttribute("aria-expanded", "true");
    }

    function closeMenu() {
      mobileMenu.classList.remove("is-open");
      hamburger.setAttribute("aria-expanded", "false");
    }

    function toggleMenu() {
      const isOpen = mobileMenu.classList.contains("is-open");
      if (isOpen) closeMenu();
      else openMenu();
    }

    // Toggle su click hamburger
    hamburger.addEventListener("click", function (e) {
      e.preventDefault();
      e.stopPropagation();
      toggleMenu();
    });

    // Chiudi cliccando fuori
    document.addEventListener("click", function (e) {
      const target = e.target;
      if (!(target instanceof Element)) return;

      const clickedInside = nav.contains(target);
      if (!clickedInside) closeMenu();
    });

    // Chiudi con ESC
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape") closeMenu();
    });

    // Chiudi quando si clicca un link nel menu
    mobileMenu.addEventListener("click", function (e) {
      const target = e.target;
      if (!(target instanceof Element)) return;

      const link = target.closest("a");
      if (link) closeMenu();
    });

    // Safety: chiudi quando cambia dimensione (es. rotazione)
    window.addEventListener("resize", function () {
      closeMenu();
    });

    // Stato iniziale
    closeMenu();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", setupNavbar);
  } else {
    setupNavbar();
  }
})();
