const dropZone = document.getElementById('drop-zone');
const fileInput = document.getElementById('file-input');
const selectButton = document.getElementById('select-button');
const app = document.getElementById('app');
const tooltip = document.getElementById('tooltip');
const pathCanvas = document.getElementById('path-canvas');
const graphCanvas = document.getElementById('graph-canvas');
const graphMetric = document.getElementById('graph-metric');
const graphXAxis = document.getElementById('graph-x-axis');
const unitToggle = document.getElementById('unit-toggle');
const loadExtraDataButton = document.getElementById('load-extra-data');
const downloadButton = document.getElementById('download-button');
const statsPanel = document.getElementById('stats-panel');

const THEME = {
  ocean: '#1a2a3a',
  land: '#2d3d2d',
  urban: '#606060',
  border: 'rgba(150, 150, 150, 0.5)',
  selection: 'rgba(0, 123, 255, 0.3)',
  highlight: 'white',
  highlightBorder: 'black',
  selectionHighlight: 'orange'
};

let gpxData = null;

let worldData = null;
let urbanData = null;
let riversData = null;
let lakesData = null;
let mapCacheCanvas = null;
let originalContent = '';
let points = [];
let selection = null; // {start: index, end: index}

let hoveredIndex = null;

selectButton.onclick = () => fileInput.click();
fileInput.onchange = (e) => handleFile(e.target.files[0]);

dropZone.ondragover = (e) => {
  e.preventDefault();
  dropZone.classList.add('drag-over');
};

dropZone.ondragleave = () => dropZone.classList.remove('drag-over');

dropZone.ondrop = (e) => {
  e.preventDefault();
  dropZone.classList.remove('drag-over');
  handleFile(e.dataTransfer.files[0]);
};

async function handleFile(file) {
  if (!file) return;
  const text = await file.text();
  originalContent = text;
  parseGPX(text);
  mapCacheCanvas = null; // Reset cache for new projection
  dropZone.style.display = 'none';
  app.style.display = 'flex';
  renderPath();
  renderGraph();
  updateStatsPanel();
}

async function loadWorldData(extra = false) {
  try {
    if (extra) {
      const [countriesRes, urbanRes, riversRes, lakesRes] = await Promise.all([
        fetch('https://raw.githubusercontent.com/martynafford/natural-earth-geojson/refs/heads/master/10m/cultural/ne_10m_admin_0_countries.json'),
        fetch('https://raw.githubusercontent.com/martynafford/natural-earth-geojson/refs/heads/master/10m/cultural/ne_10m_urban_areas.json'),
        fetch('https://raw.githubusercontent.com/martynafford/natural-earth-geojson/refs/heads/master/10m/physical/ne_10m_rivers_lake_centerlines.json'),
        fetch('https://raw.githubusercontent.com/martynafford/natural-earth-geojson/refs/heads/master/10m/physical/ne_10m_lakes.json')
      ]);
      worldData = await countriesRes.json();
      urbanData = await urbanRes.json();
      riversData = await riversRes.json();
      lakesData = await lakesRes.json();
    } else {
      const res = await fetch('https://cdn.jsdelivr.net/npm/world-atlas@2/countries-10m.json');
      worldData = await res.json();
      urbanData = null;
      riversData = null;
      lakesData = null;
    }
  } catch (e) {
    console.error('Failed to load map data:', e);
  }
}

loadWorldData();

loadExtraDataButton.onclick = async () => {
  loadExtraDataButton.disabled = true;
  await loadWorldData(true);
  mapCacheCanvas = null;
  renderPath();
};

function parseGPX(text) {
  const parser = new DOMParser();
  const xml = parser.parseFromString(text, 'text/xml');
  const trkpts = xml.querySelectorAll('trkpt');

  // 1. Extraction & Basic Filtering
  let currentPoints = [];
  trkpts.forEach((pt, i) => {
    const src = pt.querySelector('src')?.textContent;
    if (!src || src === 'gps') {
      const lat = parseFloat(pt.getAttribute('lat'));
      const lon = parseFloat(pt.getAttribute('lon'));
      const ele = parseFloat(pt.querySelector('ele')?.textContent || 0);
      const timeStr = pt.querySelector('time')?.textContent;
      const time = timeStr ? new Date(timeStr).getTime() : null;
      currentPoints.push({ lat, lon, ele, time, originalIndex: i });
    }
  });

  // 2. Geometric Spike Filter (The Shortcut Test)
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = 1; i < currentPoints.length - 1; i++) {
      const pPrev = currentPoints[i-1];
      const pCurr = currentPoints[i];
      const pNext = currentPoints[i+1];

      const d1 = haversine(pPrev.lat, pPrev.lon, pCurr.lat, pCurr.lon);
      const d2 = haversine(pCurr.lat, pCurr.lon, pNext.lat, pNext.lon);
      const dShort = haversine(pPrev.lat, pPrev.lon, pNext.lat, pNext.lon);

      // If the path A->B->C is significantly longer than A->C
      if ((d1 + d2) > 1.7 * dShort) {
        const dt = (pCurr.time - pPrev.time) / 1000;
        // Lower threshold: if it's a spike and speed is > 18km/h (5m/s), it's likely noise
        if (dt > 0 && (d1 / dt) > 5) { 
          currentPoints.splice(i, 1);
          changed = true;
          break; 
        }
      }
    }
  }

  // 3. Dynamic Speed Ceiling
  // First pass: calculate rough avg moving speed
  let totalDist = 0;
  let movingTime = 0;
  for (let i = 1; i < currentPoints.length; i++) {
    const p1 = currentPoints[i-1];
    const p2 = currentPoints[i];
    const d = haversine(p1.lat, p1.lon, p2.lat, p2.lon);
    const dt = (p2.time - p1.time) / 1000;
    if (dt > 0) {
      const speed = d / dt;
      if (speed > 0.5) movingTime += dt;
      totalDist += d;
    }
  }
  const avgMovingSpeed = movingTime > 0 ? (totalDist / movingTime) : 0;
  // Stricter ceiling: 10x avg moving speed, with a reasonable fallback
  const speedCeiling = Math.max(avgMovingSpeed * 10, 10); 

  // Second pass: filter by ceiling
  const filteredPoints = [];
  for (let i = 0; i < currentPoints.length; i++) {
    if (i === 0) {
      filteredPoints.push(currentPoints[i]);
      continue;
    }
    const pPrev = filteredPoints[filteredPoints.length - 1];
    const pCurr = currentPoints[i];
    const d = haversine(pPrev.lat, pPrev.lon, pCurr.lat, pCurr.lon);
    const dt = (pCurr.time - pPrev.time) / 1000;
    if (dt > 0 && (d / dt) > speedCeiling) {
      continue; // Reject outlier
    }
    filteredPoints.push(pCurr);
  }

  // 4. Final Augmentation
  points = [];
  let runningDist = 0;
  for (let i = 0; i < filteredPoints.length; i++) {
    const p = filteredPoints[i];
    let dist = 0;
    if (i > 0) {
      const prev = filteredPoints[i-1];
      dist = haversine(prev.lat, prev.lon, p.lat, p.lon);
      runningDist += dist;
    }
    points.push({ ...p, dist: runningDist, index: i });
  }

  // Calculate speeds
  points[0].speed = 0;
  for (let i = 1; i < points.length; i++) {
    const p1 = points[i-1];
    const p2 = points[i];
    const dt = (p2.time - p1.time) / 1000;
    const dx = p2.dist - p1.dist;
    points[i].speed = dt > 0 ? dx / dt : 0;
  }

  // Smoothing for graph
  const windowSize = 5;
  points.forEach((p, i) => {
    const start = Math.max(0, i - windowSize);
    const end = Math.min(points.length, i + windowSize);
    const slice = points.slice(start, end);
    p.smoothSpeed = slice.reduce((acc, curr) => acc + curr.speed, 0) / slice.length;
    p.smoothEle = slice.reduce((acc, curr) => acc + curr.ele, 0) / slice.length;
  });
}

function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon/2) * Math.sin(dLon/2);
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

function calculateStats(pts) {
  if (!pts || pts.length === 0) return null;

  const startT = pts[0].time;
  const endT = pts[pts.length - 1].time;
  const totalDuration = (endT - startT) / 1000;
  const totalDist = pts[pts.length - 1].dist - pts[0].dist;

  let movingTime = 0;
  let totalClimb = 0;
  let totalDescent = 0;
  let maxAltitude = -Infinity;
  let maxSpeed = 0;

  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    if (p.ele > maxAltitude) maxAltitude = p.ele;

    if (i > 0) {
      const p1 = pts[i-1];
      const p2 = p;

      // Moving time: speed > 0.5 m/s
      if (p2.speed > 0.5) {
        movingTime += (p2.time - p1.time) / 1000;
      }

      const eleDiff = p2.ele - p1.ele;
      if (eleDiff > 0) totalClimb += eleDiff;
      else totalDescent += Math.abs(eleDiff);
    }
  }

  // 5pt sliding window for max speed
  let windowMax = 0;
  for (let i = 0; i <= pts.length - 5; i++) {
    let sum = 0;
    for (let j = 0; j < 5; j++) {
      sum += pts[i + j].speed;
    }
    const avg = sum / 5;
    if (avg > windowMax) windowMax = avg;
  }
  // Handle cases with < 5 points
  if (pts.length < 5) {
    windowMax = pts.reduce((max, p) => Math.max(max, p.speed), 0);
  }
  maxSpeed = windowMax;

  const avgMovingSpeed = movingTime > 0 ? (totalDist / movingTime) : 0;

  return {
    startT,
    endT,
    totalDuration,
    totalDist,
    movingTime,
    avgMovingSpeed,
    maxSpeed,
    totalClimb,
    totalDescent,
    maxAltitude
  };
}

function formatStats(stats) {
  if (!stats) return '';
  const isImperial = unitToggle.checked;

  const fmtDate = (t) => t ? new Date(t).toLocaleString() : 'N/A';

  let dist, mTime, avgSpeed, climb, descent, maxAlt, maxSpd, dUnit, sUnit, eUnit;

  if (isImperial) {
    dist = (stats.totalDist * 0.000621371).toFixed(2) + ' mi';
    avgSpeed = (stats.avgMovingSpeed * 2.23694).toFixed(1) + ' mph';
    maxSpd = (stats.maxSpeed * 2.23694).toFixed(1) + ' mph';
    climb = (stats.totalClimb * 3.28084).toFixed(0) + ' ft';
    descent = (stats.totalDescent * 3.28084).toFixed(0) + ' ft';
    maxAlt = (stats.maxAltitude * 3.28084).toFixed(0) + ' ft';
    dUnit = 'mi'; sUnit = 'mph'; eUnit = 'ft';
  } else {
    dist = (stats.totalDist / 1000).toFixed(2) + ' km';
    avgSpeed = (stats.avgMovingSpeed * 3.6).toFixed(1) + ' km/h';
    maxSpd = (stats.maxSpeed * 3.6).toFixed(1) + ' km/h';
    climb = stats.totalClimb.toFixed(0) + ' m';
    descent = stats.totalDescent.toFixed(0) + ' m';
    maxAlt = stats.maxAltitude.toFixed(0) + ' m';
    dUnit = 'km'; sUnit = 'km/h'; eUnit = 'm';
  }

  const fmtSecs = (s) => {
    const hrs = Math.floor(s / 3600);
    const mins = Math.floor((s % 3600) / 60);
    const secs = Math.floor(s % 60);
    if (hrs > 0) return `${hrs}h ${mins}m ${secs}s`;
    if (mins > 0) return `${mins}m ${secs}s`;
    return `${secs}s`;
  };

  const totalDurationFormatted = fmtSecs(stats.totalDuration);
  const movingTimeFormatted = fmtSecs(stats.movingTime);

  return `
        <div class="stats-group">
            <div class="stats-item"><span class="stats-label">Start:</span><span class="stats-value">${fmtDate(stats.startT)}</span></div>
            <div class="stats-item"><span class="stats-label">End:</span><span class="stats-value">${fmtDate(stats.endT)}</span></div>
            <div class="stats-item"><span class="stats-label">Duration:</span><span class="stats-value">${totalDurationFormatted}</span></div>
        </div>
        <div class="stats-group">
            <div class="stats-item"><span class="stats-label">Distance:</span><span class="stats-value">${dist}</span></div>
            <div class="stats-item"><span class="stats-label">Avg Moving Speed:</span><span class="stats-value">${avgSpeed}</span></div>
            <div class="stats-item"><span class="stats-label">Max Speed:</span><span class="stats-value">${maxSpd}</span></div>
            <div class="stats-item"><span class="stats-label">Moving Time:</span><span class="stats-value">${movingTimeFormatted}</span></div>
        </div>
        <div class="stats-group">
            <div class="stats-item"><span class="stats-label">Max Altitude:</span><span class="stats-value">${maxAlt}</span></div>
            <div class="stats-item"><span class="stats-label">Total Climb:</span><span class="stats-value">${climb}</span></div>
            <div class="stats-item"><span class="stats-label">Total Descent:</span><span class="stats-value">${descent}</span></div>
            <div class="stats-item"><span class="stats-label">Net Elevation:</span><span class="stats-value">${(stats.totalClimb - stats.totalDescent).toFixed(0)} ${eUnit}</span></div>
        </div>
    `;
}

function updateStatsPanel() {
  let ptsToAnalyze = points;
  if (selection) {
    ptsToAnalyze = points.slice(selection.start, selection.end + 1);
  }

  const stats = calculateStats(ptsToAnalyze);
  statsPanel.innerHTML = formatStats(stats);
}

function getColor(speed) {

  // Speed in m/s. 0 = blue, 5 = green, 10 = yellow, 15+ = red
  const s = Math.max(0, Math.min(speed, 15));
  const r = Math.floor((s / 15) * 255);
  const b = Math.floor((1 - s / 15) * 255);
  const g = s > 5 && s < 12 ? 255 : Math.floor((1 - Math.abs(s - 8) / 8) * 255);
  return `rgb(${r}, ${g}, ${b})`;
}

function updateTooltip(e) {
  if (hoveredIndex === null) {
    tooltip.style.display = 'none';
    return;
  }
  const p = points[hoveredIndex];
  const isImperial = unitToggle.checked;

  let speed, dist, ele, sUnit, dUnit, eUnit;

  if (isImperial) {
    speed = (p.speed * 2.23694).toFixed(1);
    dist = (p.dist * 0.000621371).toFixed(2);
    ele = (p.ele * 3.28084).toFixed(1);
    sUnit = 'mph';
    dUnit = 'mi';
    eUnit = 'ft';
  } else {
    speed = (p.speed * 3.6).toFixed(1);
    dist = (p.dist / 1000).toFixed(2);
    ele = p.ele.toFixed(1);
    sUnit = 'km/h';
    dUnit = 'km';
    eUnit = 'm';
  }

  tooltip.innerHTML = `Speed: ${speed} ${sUnit}\nDistance: ${dist} ${dUnit}\nElevation: ${ele} ${eUnit}`;
  tooltip.style.display = 'block';
  tooltip.style.left = (e.clientX + 15) + 'px';
  tooltip.style.top = (e.clientY + 15) + 'px';
}

function renderMapToCache(drawWidth, drawHeight, minLon, maxLon, minLat, maxLat, deltaLon, deltaLat, offsetX, offsetY, plotWidth, plotHeight) {
  const cache = document.createElement('canvas');
  cache.width = drawWidth * 2;
  cache.height = drawHeight * 2;
  const ctx = cache.getContext('2d');
  ctx.scale(2, 2);

  // 1. Background (Ocean)
  ctx.fillStyle = THEME.ocean;
  ctx.fillRect(0, 0, drawWidth, drawHeight);

  const project = (coord) => {
    const x = ((coord[0] - minLon) / deltaLon) * plotWidth + offsetX;
    const y = drawHeight - (((coord[1] - minLat) / deltaLat) * plotHeight + offsetY);
    return [x, y];
  };

  const drawPoly = (poly, color, isFill = true) => {
    if (isFill) ctx.fillStyle = color;
    else ctx.strokeStyle = color;

    poly.forEach(ring => {
      ctx.beginPath();
      ring.forEach((coord, i) => {
        const [x, y] = project(coord);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      if (isFill) ctx.fill();
      else ctx.stroke();
    });
  };

  const drawGeoJSON = (data, color, isPolygon = true, isFill = true) => {
    if (!data) return;
    const features = data.features || (Array.isArray(data) ? data : null);
    if (!features) return;

    features.forEach(feature => {
      if (!feature || !feature.geometry) return;
      const { coordinates, type } = feature.geometry;
      if (!coordinates) return;

      if (type === 'Polygon') {
        drawPoly(coordinates, color, isFill);
      } else if (type === 'MultiPolygon') {
        coordinates.forEach(poly => drawPoly(poly, color, isFill));
      } else if (type === 'LineString' && !isPolygon) {
        ctx.beginPath();
        ctx.strokeStyle = color;
        coordinates.forEach((coord, i) => {
          const [x, y] = project(coord);
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        });
        ctx.stroke();
      } else if (type === 'MultiLineString' && !isPolygon) {
        coordinates.forEach(line => {
          ctx.beginPath();
          ctx.strokeStyle = color;
          line.forEach((coord, i) => {
            const [x, y] = project(coord);
            if (i === 0) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
          });
          ctx.stroke();
        });
      }
    });
  };

  // 2. Land
  if (worldData) {
    if (worldData.objects) {
      // Handle TopoJSON (fallback)
      const land = topojson.feature(worldData, worldData.objects.land || worldData.objects.countries);
      drawGeoJSON(land, THEME.land);
    } else if (worldData.features) {
      // Handle GeoJSON (new source)
      drawGeoJSON(worldData, THEME.land);
    }
  }

  // 3. Lakes (Cut out of land)
  drawGeoJSON(lakesData, THEME.ocean);

  // 4. Rivers (Cut out of land)
  ctx.lineWidth = 0.8;
  drawGeoJSON(riversData, THEME.ocean, false, false);

  // 5. Urban Areas
  drawGeoJSON(urbanData, THEME.urban);

  // 6. Borders
  if (worldData) {
    let countries;
    if (worldData.objects) {
      countries = topojson.feature(worldData, worldData.objects.countries);
    } else {
      countries = worldData;
    }
    ctx.strokeStyle = THEME.border;
    ctx.lineWidth = 0.3;
    drawGeoJSON(countries, THEME.border, true, false);
  }

  return cache;
}

function renderPath() {
  const ctx = pathCanvas.getContext('2d');
  const width = pathCanvas.width = pathCanvas.offsetWidth * 2;
  const height = pathCanvas.height = 500 * 2;

  const drawWidth = width / 2;
  const drawHeight = height / 2;

  const lats = points.map(p => p.lat);
  const lons = points.map(p => p.lon);
  const minLat = Math.min(...lats), maxLat = Math.max(...lats);
  const minLon = Math.min(...lons), maxLon = Math.max(...lons);

  const deltaLat = Math.max(maxLat - minLat, 0.001);
  const deltaLon = Math.max(maxLon - minLon, 0.001);
  const avgLat = (maxLat + minLat) / 2 * Math.PI / 180;
  const aspect = (deltaLon * Math.cos(avgLat)) / deltaLat;

  let plotWidth = drawWidth - 40;
  let plotHeight = drawHeight - 40;

  if (plotWidth / plotHeight > aspect) {
    plotWidth = plotHeight * aspect;
  } else {
    plotHeight = plotWidth / aspect;
  }

  const offsetX = (drawWidth - plotWidth) / 2;
  const offsetY = (drawHeight - plotHeight) / 2;

  // Use cached map background - Draw BEFORE scaling
  if (worldData || citiesData) {
    if (!mapCacheCanvas) {
      mapCacheCanvas = renderMapToCache(drawWidth, drawHeight, minLon, maxLon, minLat, maxLat, deltaLon, deltaLat, offsetX, offsetY, plotWidth, plotHeight);
    }
    ctx.drawImage(mapCacheCanvas, 0, 0);
  }

  ctx.scale(2, 2);
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.lineWidth = 2;

  if (selection) {
    ctx.beginPath();
    ctx.strokeStyle = THEME.selectionHighlight;
    ctx.lineWidth = 4;
    for (let i = selection.start + 1; i <= selection.end; i++) {
      const p1 = points[i-1];
      const p2 = points[i];
      const x1 = ((p1.lon - minLon) / deltaLon) * plotWidth + offsetX;
      const y1 = drawHeight - (((p1.lat - minLat) / deltaLat) * plotHeight + offsetY);
      const x2 = ((p2.lon - minLon) / deltaLon) * plotWidth + offsetX;
      const y2 = drawHeight - (((p2.lat - minLat) / deltaLat) * plotHeight + offsetY);
      if (i === selection.start + 1) ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
    }
    ctx.stroke();
  }

  ctx.lineWidth = 2;
  for (let i = 1; i < points.length; i++) {
    const p1 = points[i-1];
    const p2 = points[i];
    ctx.beginPath();
    ctx.strokeStyle = getColor(p2.speed);
    const x1 = ((p1.lon - minLon) / deltaLon) * plotWidth + offsetX;
    const y1 = drawHeight - (((p1.lat - minLat) / deltaLat) * plotHeight + offsetY);
    const x2 = ((p2.lon - minLon) / deltaLon) * plotWidth + offsetX;
    const y2 = drawHeight - (((p2.lat - minLat) / deltaLat) * plotHeight + offsetY);
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
  }


  if (hoveredIndex !== null) {
    const p = points[hoveredIndex];
    const x = ((p.lon - minLon) / deltaLon) * plotWidth + offsetX;
    const y = drawHeight - (((p.lat - minLat) / deltaLat) * plotHeight + offsetY);
    ctx.beginPath();
    ctx.fillStyle = THEME.highlight;
    ctx.arc(x, y, 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = THEME.highlightBorder;
    ctx.stroke();
  }
}


function renderGraph() {
  const ctx = graphCanvas.getContext('2d');
  const width = graphCanvas.width = graphCanvas.offsetWidth * 2;
  const height = graphCanvas.height = 300 * 2;
  ctx.scale(2, 2);
  const drawWidth = width / 2;
  const drawHeight = height / 2;

  const metric = graphMetric.value;
  const xAxis = graphXAxis.value;

  const yValues = points.map(p => metric === 'speed' ? p.smoothSpeed : p.smoothEle);
  const xValues = points.map(p => xAxis === 'time' ? (p.time || 0) : p.dist);

  const minY = Math.min(...yValues);
  const maxY = Math.max(...yValues);
  const minX = Math.min(...xValues);
  const maxX = Math.max(...xValues);

  ctx.clearRect(0, 0, drawWidth, drawHeight);

  ctx.lineWidth = 1;

  for (let i = 1; i < points.length; i++) {
    const p1 = points[i-1];
    const p2 = points[i];
    ctx.beginPath();
    ctx.strokeStyle = getColor(p2.speed);
    const valY1 = metric === 'speed' ? p1.smoothSpeed : p1.smoothEle;
    const valX1 = xAxis === 'time' ? (p1.time || 0) : p1.dist;
    const valY2 = metric === 'speed' ? p2.smoothSpeed : p2.smoothEle;
    const valX2 = xAxis === 'time' ? (p2.time || 0) : p2.dist;

    const x1 = ((valX1 - minX) / (maxX - minX)) * (drawWidth - 40) + 20;
    const y1 = drawHeight - (((valY1 - minY) / (maxY - minY)) * (drawHeight - 40) + 20);
    const x2 = ((valX2 - minX) / (maxX - minX)) * (drawWidth - 40) + 20;
    const y2 = drawHeight - (((valY2 - minY) / (maxY - minY)) * (drawHeight - 40) + 20);

    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
  }

  if (selection) {
    ctx.fillStyle = THEME.selection;
    const startX = ((xValues[selection.start] - minX) / (maxX - minX)) * (drawWidth - 40) + 20;
    const endX = ((xValues[selection.end] - minX) / (maxX - minX)) * (drawWidth - 40) + 20;
    ctx.fillRect(startX, 0, endX - startX, drawHeight);
  }

  if (hoveredIndex !== null) {
    const p = points[hoveredIndex];
    const valX = xAxis === 'time' ? (p.time || 0) : p.dist;
    const x = ((valX - minX) / (maxX - minX)) * (drawWidth - 40) + 20;
    ctx.beginPath();
    ctx.strokeStyle = THEME.highlight;
    ctx.moveTo(x, 0);
    ctx.lineTo(x, drawHeight);
    ctx.stroke();
  }
}

function getIdxFromX(px, canvasWidth, xAxis) {
  const xValues = points.map(p => xAxis === 'time' ? (p.time || 0) : p.dist);
  const minX = Math.min(...xValues);
  const maxX = Math.max(...xValues);
  const valX = ((px - 20) / (canvasWidth - 40)) * (maxX - minX) + minX;

  let closestIdx = 0;
  let minDiff = Infinity;
  for(let i=0; i<points.length; i++) {
    const pX = xAxis === 'time' ? (points[i].time || 0) : points[i].dist;
    const diff = Math.abs(pX - valX);
    if(diff < minDiff) {
      minDiff = diff;
      closestIdx = i;
    }
  }
  return closestIdx;
}

let isDragging = false;
let dragStart = 0;

graphCanvas.onmousedown = (e) => {
  isDragging = true;
  const rect = graphCanvas.getBoundingClientRect();
  dragStart = e.clientX - rect.left;
  selection = { start: 0, end: 0 };
};

graphCanvas.onmousemove = (e) => {
  const rect = graphCanvas.getBoundingClientRect();
  const currentX = e.clientX - rect.left;
  const xAxis = graphXAxis.value;
  const drawWidth = graphCanvas.offsetWidth;

  hoveredIndex = getIdxFromX(currentX, drawWidth, xAxis);

  if (isDragging) {
    const idx1 = getIdxFromX(dragStart, drawWidth, xAxis);
    const idx2 = getIdxFromX(currentX, drawWidth, xAxis);

    selection = {
      start: Math.min(idx1, idx2),
      end: Math.max(idx1, idx2)
    };
    downloadButton.disabled = false;
  }

  updateTooltip(e);
  renderGraph();
  renderPath();
  updateStatsPanel();
};;

graphCanvas.onmouseup = () => {
  isDragging = false;
};

pathCanvas.onmousemove = (e) => {
  const rect = pathCanvas.getBoundingClientRect();
  const mx = e.clientX - rect.left;
  const my = e.clientY - rect.top;

  const lats = points.map(p => p.lat);
  const lons = points.map(p => p.lon);
  const minLat = Math.min(...lats), maxLat = Math.max(...lats);
  const minLon = Math.min(...lons), maxLon = Math.max(...lons);
  const deltaLat = Math.max(maxLat - minLat, 0.001);
  const deltaLon = Math.max(maxLon - minLon, 0.001);
  const avgLat = (maxLat + minLat) / 2 * Math.PI / 180;
  const aspect = (deltaLon * Math.cos(avgLat)) / deltaLat;

  let plotWidth = pathCanvas.offsetWidth - 40;
  let plotHeight = 500 - 40;
  if (plotWidth / plotHeight > aspect) {
    plotWidth = plotHeight * aspect;
  } else {
    plotHeight = plotWidth / aspect;
  }
  const offsetX = (pathCanvas.offsetWidth - plotWidth) / 2;
  const offsetY = (500 - plotHeight) / 2;

  let closestIdx = 0;
  let minDist = Infinity;
  points.forEach((p, i) => {
    const x = ((p.lon - minLon) / deltaLon) * plotWidth + offsetX;
    const y = 500 - (((p.lat - minLat) / deltaLat) * plotHeight + offsetY);
    const d = Math.hypot(x - mx, y - my);
    if (d < minDist) {
      minDist = d;
      closestIdx = i;
    }
  });
  hoveredIndex = closestIdx;
  updateTooltip(e);
  renderPath();
  renderGraph();
};

graphMetric.onchange = () => {
  renderGraph();
  updateStatsPanel();
};
graphXAxis.onchange = () => {
  renderGraph();
  updateStatsPanel();
};
unitToggle.onchange = () => {
  updateStatsPanel();
  renderGraph();
  renderPath();
};

downloadButton.onclick = () => {
  if (!selection) return;

  const parser = new DOMParser();
  const xmlDoc = parser.parseFromString(originalContent, 'text/xml');
  const trkpts = Array.from(xmlDoc.querySelectorAll('trkpt'));

  const startIdx = points[selection.start].originalIndex;
  const endIdx = points[selection.end].originalIndex;

  trkpts.forEach((pt, i) => {
    if (i < startIdx || i > endIdx) {
      pt.parentNode.removeChild(pt);
    }
  });

  const serializer = new XMLSerializer();
  const updatedGpx = serializer.serializeToString(xmlDoc).replace(/\r?\n\s*\r?\n/g, '\n');

  const blob = new Blob([updatedGpx], { type: 'application/gpx+xml' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'cut_track.gpx';
  a.click();
  URL.revokeObjectURL(url);
};


