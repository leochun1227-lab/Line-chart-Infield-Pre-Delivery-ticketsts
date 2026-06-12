const FIREBASE_DB_URL = 'https://snowy-hr-report-default-rtdb.asia-southeast1.firebasedatabase.app';
const FIREBASE_ROOT = 'c4cTickets_test';
const START_YEAR = 2024;
const AUTO_REFRESH_MS = 15 * 60 * 1000;
const IN_FIELD_KEYWORDS = ['in field', 'in-field', 'infield', 'field warranty'];
const PRE_DELIVERY_KEYWORDS = ['pre delivery', 'pre-delivery', 'predelivery', 'pdi'];
const DEFAULT_RANGE_MODE = 'last12';

const chartCanvas = document.getElementById('claimsChart');
const refreshButton = document.getElementById('refreshButton');
const rangeModeSelect = document.getElementById('rangeModeSelect');
const yearSelect = document.getElementById('yearSelect');
const customRange = document.getElementById('customRange');
const startMonthInput = document.getElementById('startMonth');
const endMonthInput = document.getElementById('endMonth');
const loadingOverlay = document.getElementById('loadingOverlay');
const lastUpdated = document.getElementById('lastUpdated');
const statusMessage = document.getElementById('statusMessage');
let claimsChart;
let latestDashboardData = null;

function firebaseUrl(path) {
  return `${FIREBASE_DB_URL}/${path}.json`;
}

async function fetchJson(path) {
  const response = await fetch(firebaseUrl(path), { cache: 'no-store' });
  if (!response.ok) {
    throw new Error(`Firebase request failed for ${path}: ${response.status}`);
  }
  return response.json();
}

function asObject(node) {
  if (!node) return {};
  if (Array.isArray(node)) {
    return Object.fromEntries(node.map((value, index) => [String(index), value]).filter(([, value]) => value));
  }
  return typeof node === 'object' ? node : {};
}

function normalizeClaimText(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[_-]/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function matchesAnyKeyword(searchText, keywords) {
  const compactText = searchText.replace(/\s/g, '');
  return keywords.some((keyword) => {
    const normalizedKeyword = normalizeClaimText(keyword);
    return searchText.includes(normalizedKeyword) || compactText.includes(normalizedKeyword.replace(/\s/g, ''));
  });
}

function classifyTicket(ticket) {
  const preferredFields = [
    'TicketTypeText',
    'TicketType',
    'TicketName',
    'Subject',
    'Name',
    'Category',
    'ServiceCategory',
    'ClaimType',
    'WarrantyClaimType',
    'Claim Type',
    'Warranty Claim Type',
    'Warranty Type',
  ];
  const values = preferredFields.map((field) => ticket?.[field]);

  Object.values(ticket || {}).forEach((value) => {
    if (value == null || ['string', 'number', 'boolean'].includes(typeof value)) {
      values.push(value);
    }
  });

  const searchText = values.map(normalizeClaimText).filter(Boolean).join(' ');
  if (matchesAnyKeyword(searchText, PRE_DELIVERY_KEYWORDS)) return 'preDelivery';
  if (matchesAnyKeyword(searchText, IN_FIELD_KEYWORDS)) return 'inField';
  return '';
}

function parseCreatedOnMonth(createdOn) {
  const raw = String(createdOn ?? '').trim();
  if (!raw) return '';

  const directMatch = raw.match(/^(\d{4})[-/](\d{1,2})/);
  if (directMatch) {
    const month = Number(directMatch[2]);
    if (month >= 1 && month <= 12) return `${directMatch[1]}-${String(month).padStart(2, '0')}`;
  }

  const auDateMatch = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (auDateMatch) {
    const month = Number(auDateMatch[2]);
    if (month >= 1 && month <= 12) return `${auDateMatch[3]}-${String(month).padStart(2, '0')}`;
  }

  const sapDateMatch = raw.match(/\/Date\((-?\d+)/);
  if (sapDateMatch) {
    const dt = new Date(Number(sapDateMatch[1]));
    if (!Number.isNaN(dt.getTime())) return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}`;
  }

  const dt = new Date(raw);
  if (Number.isNaN(dt.getTime())) return '';
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}`;
}

function formatMonthLabel(monthKey, fallback) {
  if (fallback) return fallback;
  const [year, month] = String(monthKey || '').split('-').map(Number);
  if (!year || !month) return monthKey;
  return new Date(Date.UTC(year, month - 1, 1)).toLocaleString('en-AU', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

function getCurrentMonthKey() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

function monthKeyToDate(monthKey) {
  const [year, month] = String(monthKey || '').split('-').map(Number);
  return new Date(Date.UTC(year || START_YEAR, (month || 1) - 1, 1));
}

function addMonths(monthKey, delta) {
  const dt = monthKeyToDate(monthKey);
  dt.setUTCMonth(dt.getUTCMonth() + delta);
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}`;
}

function iterMonthKeys(startMonth, endMonth) {
  if (!startMonth || !endMonth || startMonth > endMonth) return [];
  const out = [];
  let cursor = startMonth;
  while (cursor <= endMonth) {
    out.push(cursor);
    cursor = addMonths(cursor, 1);
  }
  return out;
}

function makeMonthRow(month, counts = {}) {
  const inField = Number(counts.inField || 0);
  const preDelivery = Number(counts.preDelivery || 0);
  return {
    month,
    label: formatMonthLabel(month),
    inField,
    preDelivery,
    total: inField + preDelivery,
  };
}

function normalizeSeries(rows) {
  return (Array.isArray(rows) ? rows : [])
    .filter((row) => row && row.month)
    .sort((a, b) => String(a.month).localeCompare(String(b.month)))
    .map((row) => makeMonthRow(row.month, row));
}

function buildSeriesFromTickets(ticketsNode) {
  const tickets = asObject(ticketsNode);
  const monthly = {};
  let matchedTicketCount = 0;
  let unmatchedTicketCount = 0;
  let missingCreatedOnCount = 0;

  Object.values(tickets).forEach((node) => {
    const ticket = node?.ticket || node;
    if (!ticket || typeof ticket !== 'object') return;

    const bucket = classifyTicket(ticket);
    if (!bucket) {
      unmatchedTicketCount += 1;
      return;
    }

    const month = parseCreatedOnMonth(ticket.CreatedOn);
    if (!month) {
      missingCreatedOnCount += 1;
      return;
    }
    if (Number(month.slice(0, 4)) < START_YEAR) return;

    matchedTicketCount += 1;
    monthly[month] ||= { inField: 0, preDelivery: 0 };
    monthly[month][bucket] += 1;
  });

  const currentMonth = getCurrentMonthKey();
  const dataMonths = Object.keys(monthly).sort();
  const latestMonth = dataMonths.length ? dataMonths[dataMonths.length - 1] : currentMonth;
  const minMonth = `${START_YEAR}-01`;
  const maxMonth = latestMonth > currentMonth ? currentMonth : latestMonth;
  const maxYear = Number(maxMonth.slice(0, 4));
  const availableYears = Array.from({ length: maxYear - START_YEAR + 1 }, (_, index) => START_YEAR + index);

  return {
    monthly,
    minMonth,
    maxMonth,
    latestMonth: maxMonth,
    availableYears,
    latestSyncAt: null,
    source: `${FIREBASE_ROOT}/tickets/*/ticket.CreatedOn`,
    matchedTicketCount,
    unmatchedTicketCount,
    missingCreatedOnCount,
  };
}

async function fetchSyncTimestamp() {
  const candidates = ['claimsReceivedLatestSyncAt', 'ticketCoreSyncAt', 'ticketSoSyncAt'];
  const values = await Promise.allSettled(candidates.map((key) => fetchJson(`${FIREBASE_ROOT}/${key}`)));
  return values.map((result) => (result.status === 'fulfilled' ? result.value : null)).find(Boolean) || null;
}

async function fetchDashboardData() {
  const [ticketsNode, syncTimestamp] = await Promise.all([
    fetchJson(`${FIREBASE_ROOT}/tickets`),
    fetchSyncTimestamp(),
  ]);
  const data = buildSeriesFromTickets(ticketsNode);
  return { ...data, latestSyncAt: syncTimestamp, usedLiveTickets: true };
}

function makePointLabels() {
  return {
    id: 'pointLabels',
    afterDatasetsDraw(chart) {
      const { ctx } = chart;
      ctx.save();
      ctx.font = '600 11px Inter, Segoe UI, Arial, sans-serif';
      ctx.fillStyle = '#111827';
      ctx.textAlign = 'center';
      chart.data.datasets.forEach((dataset, datasetIndex) => {
        const meta = chart.getDatasetMeta(datasetIndex);
        meta.data.forEach((point, index) => {
          const value = dataset.data[index];
          const yOffset = datasetIndex === 0 ? -9 : 15;
          ctx.fillText(String(value), point.x, point.y + yOffset);
        });
      });
      ctx.restore();
    },
  };
}

function renderChart(series) {
  const labels = series.map((row) => row.label);
  const inField = series.map((row) => row.inField);
  const preDelivery = series.map((row) => row.preDelivery);
  const maxValue = Math.max(0, ...inField, ...preDelivery);

  if (claimsChart) claimsChart.destroy();

  claimsChart = new Chart(chartCanvas, {
    type: 'line',
    data: {
      labels,
      datasets: [
        {
          label: 'In Field Warranty Claims',
          data: inField,
          borderColor: '#4c8ee8',
          backgroundColor: '#4c8ee8',
          pointBackgroundColor: '#4c8ee8',
          pointBorderColor: '#ffffff',
          pointRadius: 3,
          pointHoverRadius: 5,
          borderWidth: 2,
          tension: 0.18,
        },
        {
          label: 'Pre Delivery Warranty Claims',
          data: preDelivery,
          borderColor: '#ff7438',
          backgroundColor: '#ff7438',
          pointBackgroundColor: '#ff7438',
          pointBorderColor: '#ffffff',
          pointRadius: 3,
          pointHoverRadius: 5,
          borderWidth: 2,
          tension: 0.18,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { intersect: false, mode: 'index' },
      plugins: {
        legend: { position: 'top', align: 'end', labels: { usePointStyle: true, boxWidth: 8 } },
        tooltip: { callbacks: { label: (ctx) => `${ctx.dataset.label}: ${ctx.parsed.y}` } },
      },
      scales: {
        x: {
          grid: { display: false },
          ticks: { maxRotation: 45, minRotation: 45, color: '#475467' },
        },
        y: {
          beginAtZero: true,
          suggestedMax: Math.max(900, Math.ceil(maxValue / 100) * 100),
          ticks: { stepSize: 100, color: '#475467' },
          grid: { color: '#edf0f5' },
        },
      },
    },
    plugins: [makePointLabels()],
  });
}

function formatSyncText(timestamp) {
  if (timestamp) return `Last sync: ${new Date(timestamp).toLocaleString()}`;
  return `Last refresh: ${new Date().toLocaleString()}`;
}

function setLoading(isLoading) {
  document.body.classList.toggle('is-loading', isLoading);
  loadingOverlay.hidden = !isLoading;
  refreshButton.disabled = isLoading;
}

function clampMonthValue(value, minMonth, maxMonth, fallback) {
  if (!value) return fallback;
  if (value < minMonth) return minMonth;
  if (value > maxMonth) return maxMonth;
  return value;
}

function syncControls(data) {
  const previousMode = rangeModeSelect.value || DEFAULT_RANGE_MODE;
  const previousYear = yearSelect.value;
  const previousStart = startMonthInput.value;
  const previousEnd = endMonthInput.value;
  const years = data.availableYears || [START_YEAR];
  const latestYear = String(Number(data.latestMonth.slice(0, 4)) || years[years.length - 1]);

  yearSelect.innerHTML = years
    .map((year) => `<option value="${year}">${year}</option>`)
    .join('');
  yearSelect.value = years.map(String).includes(previousYear) ? previousYear : latestYear;

  startMonthInput.min = data.minMonth;
  startMonthInput.max = data.maxMonth;
  endMonthInput.min = data.minMonth;
  endMonthInput.max = data.maxMonth;

  const defaultStart = addMonths(data.maxMonth, -11) < data.minMonth ? data.minMonth : addMonths(data.maxMonth, -11);
  startMonthInput.value = clampMonthValue(previousStart, data.minMonth, data.maxMonth, defaultStart);
  endMonthInput.value = clampMonthValue(previousEnd, data.minMonth, data.maxMonth, data.maxMonth);
  rangeModeSelect.value = previousMode;
  updateControlVisibility();
}

function getSelectedMonthRange(data) {
  const mode = rangeModeSelect.value;
  if (mode === 'currentYear') {
    const currentYear = getCurrentMonthKey().slice(0, 4);
    return { start: `${currentYear}-01`, end: data.maxMonth < `${currentYear}-01` ? data.maxMonth : data.maxMonth, label: `${currentYear} year to date` };
  }
  if (mode === 'year') {
    const year = yearSelect.value;
    const yearEnd = `${year}-12` < data.maxMonth ? `${year}-12` : data.maxMonth;
    return { start: `${year}-01`, end: yearEnd, label: `${year}` };
  }
  if (mode === 'custom') {
    const start = startMonthInput.value || data.minMonth;
    const end = endMonthInput.value || data.maxMonth;
    return start <= end
      ? { start, end, label: `${formatMonthLabel(start)} – ${formatMonthLabel(end)}` }
      : { start: end, end: start, label: `${formatMonthLabel(end)} – ${formatMonthLabel(start)}` };
  }
  const start = addMonths(data.maxMonth, -11) < data.minMonth ? data.minMonth : addMonths(data.maxMonth, -11);
  return { start, end: data.maxMonth, label: 'Last 12 months' };
}

function updateControlVisibility() {
  const mode = rangeModeSelect.value;
  customRange.hidden = mode !== 'custom';
  yearSelect.closest('.control-field').hidden = mode !== 'year';
}

function renderSelectedRange() {
  if (!latestDashboardData) return;
  updateControlVisibility();
  const range = getSelectedMonthRange(latestDashboardData);
  const monthKeys = iterMonthKeys(range.start, range.end);
  const series = normalizeSeries(monthKeys.map((month) => makeMonthRow(month, latestDashboardData.monthly[month])));
  renderChart(series);

  if (!series.length) {
    statusMessage.textContent = `No in-field/pre-delivery claims found for ${range.label}.`;
    return;
  }

  statusMessage.textContent = `Showing ${range.label}: ${formatMonthLabel(range.start)} to ${formatMonthLabel(range.end)}. Matched ${latestDashboardData.matchedTicketCount || 0} tickets since ${START_YEAR}.`;
}

async function refreshDashboard() {
  statusMessage.textContent = 'Refreshing Firebase tickets…';
  setLoading(true);
  try {
    latestDashboardData = await fetchDashboardData();
    syncControls(latestDashboardData);
    renderSelectedRange();
    lastUpdated.textContent = formatSyncText(latestDashboardData.latestSyncAt);
  } catch (error) {
    console.error(error);
    statusMessage.textContent = error.message;
    lastUpdated.textContent = 'Refresh failed';
  } finally {
    setLoading(false);
  }
}

rangeModeSelect.addEventListener('change', renderSelectedRange);
yearSelect.addEventListener('change', renderSelectedRange);
startMonthInput.addEventListener('change', renderSelectedRange);
endMonthInput.addEventListener('change', renderSelectedRange);
refreshButton.addEventListener('click', refreshDashboard);
refreshDashboard();
window.setInterval(refreshDashboard, AUTO_REFRESH_MS);
