export function initBlockInput(onFetch: (slot: number) => void) {
  const container = document.getElementById('block-input');
  if (!container) return;

  container.innerHTML = `
    <input type="text" id="slot-input" placeholder="Enter slot number" />
    <button id="fetch-btn">Fetch Block</button>
    <button id="latest-btn">Latest</button>
  `;

  const input = document.getElementById('slot-input') as HTMLInputElement;
  const fetchBtn = document.getElementById('fetch-btn') as HTMLButtonElement;
  const latestBtn = document.getElementById('latest-btn') as HTMLButtonElement;

  function handleFetch() {
    const slot = parseInt(input.value, 10);
    if (!isNaN(slot) && slot >= 0) {
      onFetch(slot);
    }
  }

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') handleFetch();
  });

  fetchBtn.addEventListener('click', handleFetch);

  latestBtn.addEventListener('click', async () => {
    try {
      const res = await fetch('/api/block/latest-slot');
      const data = await res.json();
      if (data.slot) {
        input.value = String(data.slot);
        onFetch(data.slot);
      }
    } catch (err) {
      console.error('Failed to fetch latest slot:', err);
    }
  });

  // Handle URL state
  const params = new URLSearchParams(window.location.search);
  const slotParam = params.get('slot');
  if (slotParam) {
    const slot = parseInt(slotParam, 10);
    if (!isNaN(slot)) {
      input.value = slotParam;
      onFetch(slot);
    }
  }
}

export function setSlotInput(slot: number) {
  const input = document.getElementById('slot-input') as HTMLInputElement;
  if (input) {
    input.value = String(slot);
  }
}
