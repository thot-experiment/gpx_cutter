const dropZone = document.getElementById('drop-zone');
const fileInput = document.getElementById('file-input');
const selectButton = document.getElementById('select-button');
const app = document.getElementById('app');
const tooltip = document.getElementById('tooltip');
const pathCanvas = document.getElementById('path-canvas');
const graphCanvas = document.getElementById('graph-canvas');
const graphMetric = document.getElementById('graph-metric');
const graphXAxis = document.getElementById('graph-x-axis');
const downloadButton = document.getElementById('download-button');

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
}

async function loadWorldData() {
    try {
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
    } catch (e) {
        console.error('Failed to load map data:', e);
        try {
            const res = await fetch('https://cdn.jsdelivr.net/npm/world-atlas@2/countries-110m.json');
            worldData = await res.json();
        } catch (err) {
            console.error('Fallback failed:', err);
        }
    }
}

loadWorldData();

function parseGPX(text) {
    const parser = new DOMParser();
    const xml = parser.parseFromString(text, 'text/xml');
    const trkpts = xml.querySelectorAll('trkpt');
    
    points = [];
    let totalDistance = 0;
    let lastPt = null;

    trkpts.forEach((pt, i) => {
        const lat = parseFloat(pt.getAttribute('lat'));
        const lon = parseFloat(pt.getAttribute('lon'));
        const ele = parseFloat(pt.querySelector('ele')?.textContent || 0);
        const timeStr = pt.querySelector('time')?.textContent;
        const time = timeStr ? new Date(timeStr).getTime() : null;

        let dist = 0;
        if (lastPt) {
            dist = haversine(lastPt.lat, lastPt.lon, lat, lon);
            totalDistance += dist;
        }

        points.push({ lat, lon, ele, time, dist: totalDistance, index: i });
        lastPt = { lat, lon };
    });

    // Calculate speeds
    points[0].speed = 0;
    for (let i = 1; i < points.length; i++) {
        const p1 = points[i-1];
        const p2 = points[i];
        const dt = (p2.time - p1.time) / 1000; // seconds
        const dx = p2.dist - p1.dist; // meters
        points[i].speed = dt > 0 ? dx / dt : 0; // m/s
    }

    // Smoothing for graph (moving average)
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
    const speedKph = (p.speed * 3.6).toFixed(1);
    const distKm = (p.dist / 1000).toFixed(2);
    const eleM = p.ele.toFixed(1);
    
    tooltip.innerHTML = `Speed: ${speedKph} km/h\nDistance: ${distKm} km\nElevation: ${eleM} m`;
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
    ctx.fillStyle = '#1a2a3a';
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
        if (!data || !data.features) return;
        data.features.forEach(feature => {
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
            drawGeoJSON(land, '#2d3d2d');
        } else if (worldData.features) {
            // Handle GeoJSON (new source)
            drawGeoJSON(worldData, '#2d3d2d');
        }
    }

    // 3. Lakes (Cut out of land)
    drawGeoJSON(lakesData, '#1a2a3a');

    // 4. Rivers (Cut out of land)
    ctx.lineWidth = 0.5;
    drawGeoJSON(riversData, '#1a2a3a', false, false);

    // 5. Urban Areas
    drawGeoJSON(urbanData, '#a0a0a0');

    // 6. Borders
    if (worldData) {
        let countries;
        if (worldData.objects) {
            countries = topojson.feature(worldData, worldData.objects.countries);
        } else {
            countries = worldData;
        }
        ctx.strokeStyle = 'rgba(150, 150, 150, 0.5)';
        ctx.lineWidth = 0.3;
        drawGeoJSON(countries, 'rgba(150, 150, 150, 0.5)', true, false);
    }

    return cache;
}

function renderPath() {
    const ctx = pathCanvas.getContext('2d');
    const width = pathCanvas.width = pathCanvas.offsetWidth * 2;
    const height = pathCanvas.height = 500 * 2;
    ctx.scale(2, 2);
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

    if (worldData) {
        if (!mapCacheCanvas) {
            mapCacheCanvas = renderMapToCache(drawWidth, drawHeight, minLon, maxLon, minLat, maxLat, deltaLon, deltaLat, offsetX, offsetY, plotWidth, plotHeight);
        }
        ctx.drawImage(mapCacheCanvas, 0, 0, drawWidth, drawHeight);
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
        ctx.fillStyle = 'white';
        ctx.arc(x, y, 4, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = 'black';
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
        ctx.fillStyle = 'rgba(0, 123, 255, 0.3)';
        const startX = ((xValues[selection.start] - minX) / (maxX - minX)) * (drawWidth - 40) + 20;
        const endX = ((xValues[selection.end] - minX) / (maxX - minX)) * (drawWidth - 40) + 20;
        ctx.fillRect(startX, 0, endX - startX, drawHeight);
    }

    if (hoveredIndex !== null) {
        const p = points[hoveredIndex];
        const valX = xAxis === 'time' ? (p.time || 0) : p.dist;
        const x = ((valX - minX) / (maxX - minX)) * (drawWidth - 40) + 20;
        ctx.beginPath();
        ctx.strokeStyle = 'white';
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
};

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

graphMetric.onchange = renderGraph;
graphXAxis.onchange = renderGraph;

downloadButton.onclick = () => {
    if (!selection) return;
    
    const parser = new DOMParser();
    const xmlDoc = parser.parseFromString(originalContent, 'text/xml');
    const trkpts = Array.from(xmlDoc.querySelectorAll('trkpt'));
    
    trkpts.forEach((pt, i) => {
        if (i < selection.start || i > selection.end) {
            pt.parentNode.removeChild(pt);
        }
    });
    
    const serializer = new XMLSerializer();
    const updatedGpx = serializer.serializeToString(xmlDoc);
    
    const blob = new Blob([updatedGpx], { type: 'application/gpx+xml' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'cut_track.gpx';
    a.click();
    URL.revokeObjectURL(url);
};


