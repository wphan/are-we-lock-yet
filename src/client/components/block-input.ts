export function initBlockInput(onFetch: (slot: number) => void) {
  const container = document.getElementById('block-input');
  if (!container) return;

  container.innerHTML = `
    <button id="prev-btn" title="Previous block">&larr;</button>
    <input type="text" id="slot-input" placeholder="Enter slot number" />
    <button id="next-btn" title="Next block">&rarr;</button>
    <button id="fetch-btn">Fetch Block</button>
    <button id="latest-btn">Latest</button>
  `;

  const input = document.getElementById('slot-input') as HTMLInputElement;
  const fetchBtn = document.getElementById('fetch-btn') as HTMLButtonElement;
  const latestBtn = document.getElementById('latest-btn') as HTMLButtonElement;
  const prevBtn = document.getElementById('prev-btn') as HTMLButtonElement;
  const nextBtn = document.getElementById('next-btn') as HTMLButtonElement;

  function handleFetch() {
    const slot = parseInt(input.value, 10);
    if (!isNaN(slot) && slot >= 0) {
      onFetch(slot);
    }
  }

  function handlePrev() {
    const slot = parseInt(input.value, 10);
    if (!isNaN(slot) && slot > 0) {
      onFetch(slot - 1);
    }
  }

  function handleNext() {
    const slot = parseInt(input.value, 10);
    if (!isNaN(slot) && slot >= 0) {
      onFetch(slot + 1);
    }
  }

  async function fetchLatest() {
    try {
      const res = await fetch('/api/block/latest');
      const data = await res.json();
      if (data.slot) {
        input.value = String(data.slot);
        onFetch(data.slot);
      }
    } catch (err) {
      console.error('Failed to fetch latest slot:', err);
    }
  }

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') handleFetch();
  });

  fetchBtn.addEventListener('click', handleFetch);
  latestBtn.addEventListener('click', fetchLatest);
  prevBtn.addEventListener('click', handlePrev);
  nextBtn.addEventListener('click', handleNext);

  // Handle URL state - fetch from URL param or load latest
  const params = new URLSearchParams(window.location.search);
  const slotParam = params.get('slot');
  if (slotParam) {
    const slot = parseInt(slotParam, 10);
    if (!isNaN(slot)) {
      input.value = slotParam;
      onFetch(slot);
    }
  } else {
    // No slot in URL, fetch latest
    fetchLatest();
  }
}

export function setSlotInput(slot: number) {
  const input = document.getElementById('slot-input') as HTMLInputElement;
  if (input) {
    input.value = String(slot);
  }
}
