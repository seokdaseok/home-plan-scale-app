/* =====================================================
   PLAN/SCALE — LANDING PAGE JS
   Scroll reveal + nav scroll state only.
   ===================================================== */

// Scroll reveal
const revealEls = document.querySelectorAll('.step, .feature, .notice-inner, .cta-inner');
revealEls.forEach(el => el.classList.add('reveal'));

const observer = new IntersectionObserver((entries) => {
  entries.forEach(entry => {
    if (entry.isIntersecting) {
      entry.target.classList.add('visible');
      observer.unobserve(entry.target);
    }
  });
}, { threshold: 0.12 });

revealEls.forEach(el => observer.observe(el));

// Stagger step reveals
document.querySelectorAll('.step').forEach((el, i) => {
  el.style.transitionDelay = (i * 80) + 'ms';
});

// Screenshot placeholders: hide when the real image loads, show when it's missing.
// The placeholder sits behind the <img> by default (img is on top via z-index).
// When the image errors (file not found), we hide the img and show the placeholder.
document.querySelectorAll('.step-screenshot').forEach(container => {
  const img = container.querySelector('img');
  const placeholder = container.querySelector('.step-placeholder');
  if (!img || !placeholder) return;

  // Start with placeholder visible; hide it once image loads successfully
  img.addEventListener('load', () => {
    placeholder.style.display = 'none';
  });

  img.addEventListener('error', () => {
    img.style.display = 'none';
    placeholder.style.display = 'flex';
    // Also hide the annotation overlay — it would float over empty space
    const annot = container.querySelector('.step-annotation');
    if (annot) annot.style.display = 'none';
  });

  // Trigger error handler if image is already broken (cached state)
  if (img.complete && !img.naturalWidth) {
    img.dispatchEvent(new Event('error'));
  }
});