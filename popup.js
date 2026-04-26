const toggle = document.getElementById('toggle');

chrome.storage.sync.get({ enabled: true }, (v) => {
  toggle.checked = v.enabled;
});

toggle.addEventListener('change', () => {
  chrome.storage.sync.set({ enabled: toggle.checked });
});
