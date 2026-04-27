/**
 * AeroPlan App SPA and map mission logic.
 */

let mapInstance = null;

const DEFAULT_MAP_CENTER = [33.5184, 73.1665];
const DEFAULT_MAP_ZOOM = 13;
const EARTH_RADIUS_M = 6378137;

const missionState = {
    currentMission: null,
    featureGroup: null,
    takeoffMarker: null,
    landingMarker: null,
    areaPolygon: null,
    routeLayer: null,
    activePointMode: null,
    measuredAreaSqM: null,
    plannedPathLatLngs: []
};

window.storeMissionParameters = storeMissionParameters;

document.addEventListener('DOMContentLoaded', () => {
    setupNavigation();
    syncStoredMission();
    updateMapMissionSummary();
    updateMapControls();
});

function setupNavigation() {
    const navItems = document.querySelectorAll('.nav-item');
    const pageViews = document.querySelectorAll('.page-view');

    navItems.forEach(item => {
        item.addEventListener('click', (e) => {
            e.preventDefault();

            const targetId = item.getAttribute('data-target');

            navItems.forEach(nav => nav.classList.remove('active'));
            pageViews.forEach(view => view.classList.remove('active'));

            item.classList.add('active');
            const targetView = document.getElementById(targetId);
            if (targetView) {
                targetView.classList.add('active');
            }

            if (targetId === 'page-planner') {
                ensureMapReady();
            }

            const route = targetId.replace('page-', '');
            history.pushState(null, null, `#${route}`);
        });
    });

    const currentHash = window.location.hash.replace('#', '');
    if (currentHash) {
        const matchingLink = document.querySelector(`.nav-item[data-target="page-${currentHash}"]`);
        if (matchingLink) {
            matchingLink.click();
        }
    }
}

function syncStoredMission() {
    if (window.currentMissionParameters) {
        missionState.currentMission = window.currentMissionParameters;
        setFlightAngleInput(missionState.currentMission.flightDirectionDeg || 0);
    }
}

function storeMissionParameters(mission) {
    missionState.currentMission = mission;
    window.currentMissionParameters = mission;
    setFlightAngleInput(mission.flightDirectionDeg || 0);
    updateMapMissionSummary();
    updateMapControls();
    maybeAutoGenerateFlightPath();
}

function openMissionMap() {
    const plannerLink = document.querySelector('.nav-item[data-target="page-planner"]');
    if (plannerLink) {
        plannerLink.click();
    } else {
        ensureMapReady();
    }

    setTimeout(() => {
        if (mapInstance) {
            mapInstance.invalidateSize();
        }
        const mapPanel = document.querySelector('.planner-map-panel');
        if (mapPanel) {
            mapPanel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }
        updateMapMissionSummary();
        updateMapControls();
        if (!missionState.plannedPathLatLngs.length) {
            setMapStatus(missionState.currentMission
                ? 'Mission parameters ready. Add takeoff, landing, and area.'
                : 'Calculate mission parameters before generating a flight path.');
        }
    }, 150);
}

function ensureMapReady() {
    if (!mapInstance) {
        initMap();
    } else {
        setTimeout(() => mapInstance.invalidateSize(), 100);
    }
}

function initMap() {
    mapInstance = L.map('leaflet-map-container', {
        zoomControl: false
    }).setView(DEFAULT_MAP_CENTER, DEFAULT_MAP_ZOOM);

    L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
        maxZoom: 19,
        attribution: 'Tiles &copy; Esri - Source: Esri, i-cubed, USDA, USGS, AEX, GeoEye, Getmapping, Aerogrid, IGN, IGP, UPR-EGP, and the GIS User Community'
    }).addTo(mapInstance);

    L.control.zoom({ position: 'topright' }).addTo(mapInstance);

    missionState.featureGroup = L.featureGroup().addTo(mapInstance);

    mapInstance.on('click', handleMapClick);
    mapInstance.on('pm:create', handleCreatedLayer);
    mapInstance.on('pm:remove', handleRemovedLayer);

    if (!mapInstance.pm) {
        setMapStatus('Leaflet-Geoman did not load. Polygon drawing is unavailable.');
    }

    updateMapMissionSummary();
    updateMeasuredAreaDisplays();
    updateMapControls();
}

function updateMeasuredAreaFromPolygon() {
    if (!missionState.areaPolygon) {
        missionState.measuredAreaSqM = null;
        updateMeasuredAreaDisplays();
        return;
    }

    const areaSqM = calculatePolygonAreaSqM(missionState.areaPolygon);
    if (!Number.isFinite(areaSqM) || areaSqM <= 0) {
        setMapStatus('Could not calculate polygon area.');
        return;
    }

    missionState.measuredAreaSqM = areaSqM;
    syncMeasuredAreaToCalculator(areaSqM);
    updateMeasuredAreaDisplays();
    recalculateActivePlannerFromMeasuredArea();
}

function calculatePolygonAreaSqM(layer) {
    if (typeof turf !== 'undefined' && turf.area && layer.toGeoJSON) {
        return turf.area(layer.toGeoJSON());
    }

    const rings = layer.getLatLngs();
    const outerRing = Array.isArray(rings[0]) ? rings[0] : rings;
    return calculateSphericalPolygonArea(outerRing);
}

function calculateSphericalPolygonArea(latLngs) {
    if (!latLngs || latLngs.length < 3) {
        return 0;
    }

    let total = 0;
    for (let index = 0; index < latLngs.length; index += 1) {
        const current = latLngs[index];
        const next = latLngs[(index + 1) % latLngs.length];
        const lng1 = current.lng * Math.PI / 180;
        const lng2 = next.lng * Math.PI / 180;
        const lat1 = current.lat * Math.PI / 180;
        const lat2 = next.lat * Math.PI / 180;
        total += (lng2 - lng1) * (2 + Math.sin(lat1) + Math.sin(lat2));
    }

    return Math.abs(total * EARTH_RADIUS_M * EARTH_RADIUS_M / 2);
}

function syncMeasuredAreaToCalculator(areaSqM) {
    const areaHa = areaSqM / 10000;
    const areaValue = areaHa.toFixed(areaHa >= 10 ? 2 : 3);
    const timeAreaInput = document.getElementById('area_hectares');
    const gsdAreaInput = document.getElementById('gsd_area_hectares');

    if (timeAreaInput) {
        timeAreaInput.value = areaValue;
        timeAreaInput.readOnly = true;
    }
    if (gsdAreaInput) {
        gsdAreaInput.value = areaValue;
        gsdAreaInput.readOnly = true;
    }

    if (typeof suggestGSD === 'function') {
        suggestGSD();
    }
    if (typeof suggestFlightDuration === 'function') {
        suggestFlightDuration();
    }
}

function recalculateActivePlannerFromMeasuredArea() {
    const isGsdPlannerActive = document.getElementById('gsdCalculator')?.style.display !== 'none';

    if (isGsdPlannerActive && typeof calculateGSDMission === 'function') {
        calculateGSDMission();
    } else if (typeof calculateMission === 'function') {
        calculateMission();
    }
}

function updateMeasuredAreaDisplays() {
    const areaSqM = missionState.measuredAreaSqM;
    const areaHa = areaSqM ? areaSqM / 10000 : null;
    const areaText = areaHa ? `${areaHa.toFixed(areaHa >= 10 ? 2 : 3)} ha (${areaSqM.toFixed(0)} sq m)` : '-- ha';
    const noteText = areaHa
        ? `Using measured polygon area: ${areaText}`
        : 'Draw a polygon on the map to use measured area.';

    const readout = document.getElementById('mapAreaReadout');
    const measuredNote = document.getElementById('measuredAreaNote');
    const gsdMeasuredNote = document.getElementById('gsdMeasuredAreaNote');
    const timeAreaInput = document.getElementById('area_hectares');
    const gsdAreaInput = document.getElementById('gsd_area_hectares');

    if (readout) {
        readout.textContent = `Measured area: ${areaText}`;
    }
    if (measuredNote) {
        measuredNote.textContent = noteText;
    }
    if (gsdMeasuredNote) {
        gsdMeasuredNote.textContent = noteText;
    }
    if (!areaHa) {
        if (timeAreaInput) {
            timeAreaInput.readOnly = false;
        }
        if (gsdAreaInput) {
            gsdAreaInput.readOnly = false;
        }
    }
}

function activateTakeoffTool() {
    setPointMode('takeoff');
}

function activateLandingTool() {
    setPointMode('landing');
}

function activateAreaTool() {
    ensureMapReady();
    clearPointMode();

    if (!mapInstance.pm) {
        setMapStatus('Polygon drawing is unavailable.');
        return;
    }

    mapInstance.pm.disableDraw();
    mapInstance.pm.enableDraw('Polygon', {
        snappable: true,
        pathOptions: {
            color: '#0284c7',
            weight: 3,
            fillColor: '#0ea5e9',
            fillOpacity: 0.18
        }
    });
    setMapStatus('Draw the mission area polygon.');
}

function setPointMode(mode) {
    ensureMapReady();
    if (mapInstance.pm) {
        mapInstance.pm.disableDraw();
    }

    missionState.activePointMode = missionState.activePointMode === mode ? null : mode;
    mapInstance.getContainer().classList.toggle('mission-crosshair', Boolean(missionState.activePointMode));
    updateToolButtonState();

    if (missionState.activePointMode === 'takeoff') {
        setMapStatus('Click the map to place takeoff.');
    } else if (missionState.activePointMode === 'landing') {
        setMapStatus('Click the map to place landing.');
    } else {
        setMapStatus('Point placement cancelled.');
    }
}

function clearPointMode() {
    missionState.activePointMode = null;
    if (mapInstance) {
        mapInstance.getContainer().classList.remove('mission-crosshair');
    }
    updateToolButtonState();
}

function handleMapClick(event) {
    if (!missionState.activePointMode) {
        return;
    }

    if (missionState.activePointMode === 'takeoff') {
        setMapStatus('Takeoff point assigned.');
        setMissionPoint('takeoff', event.latlng);
    } else {
        setMapStatus('Landing point assigned.');
        setMissionPoint('landing', event.latlng);
    }

    clearPointMode();
}

function handleCreatedLayer(event) {
    if (event.shape === 'Polygon' || event.layer instanceof L.Polygon) {
        if (mapInstance.pm) {
            mapInstance.pm.disableDraw();
        }
        setMapStatus('Mission area assigned.');
        setAreaPolygon(event.layer);
    }
}

function handleRemovedLayer(event) {
    if (event.layer === missionState.areaPolygon) {
        missionState.areaPolygon = null;
        clearRouteLayer();
    }
    if (event.layer === missionState.takeoffMarker) {
        missionState.takeoffMarker = null;
        clearRouteLayer();
    }
    if (event.layer === missionState.landingMarker) {
        missionState.landingMarker = null;
        clearRouteLayer();
    }
    updateMapControls();
}

function setMissionPoint(type, latlng) {
    const existingLayer = type === 'takeoff' ? missionState.takeoffMarker : missionState.landingMarker;
    removeLayer(existingLayer);
    clearRouteLayer();

    const marker = L.marker(latlng, {
        draggable: true,
        icon: createPointIcon(type)
    });

    const label = type === 'takeoff' ? 'Takeoff' : 'Landing';
    marker.bindTooltip(label, {
        permanent: true,
        direction: 'top',
        offset: [0, -18]
    });
    marker.on('dragend', () => {
        clearRouteLayer();
        maybeAutoGenerateFlightPath();
    });

    missionState.featureGroup.addLayer(marker);

    if (type === 'takeoff') {
        missionState.takeoffMarker = marker;
    } else {
        missionState.landingMarker = marker;
    }

    updateMapControls();
    maybeAutoGenerateFlightPath();
}

function createPointIcon(type) {
    const label = type === 'takeoff' ? 'TO' : 'LD';
    const className = type === 'takeoff' ? 'takeoff-icon' : 'landing-icon';

    return L.divIcon({
        className: `mission-point-icon ${className}`,
        html: `<span>${label}</span>`,
        iconSize: [34, 34],
        iconAnchor: [17, 17]
    });
}

function setAreaPolygon(layer) {
    if (missionState.areaPolygon && missionState.areaPolygon !== layer) {
        removeLayer(missionState.areaPolygon);
    }
    clearRouteLayer();

    missionState.areaPolygon = layer;
    layer.setStyle({
        color: '#0284c7',
        weight: 3,
        fillColor: '#0ea5e9',
        fillOpacity: 0.18
    });
    layer.bindTooltip('Mission Area');

    if (!missionState.featureGroup.hasLayer(layer)) {
        missionState.featureGroup.addLayer(layer);
    }

    layer.on('pm:edit', () => {
        clearRouteLayer();
        updateMeasuredAreaFromPolygon();
        maybeAutoGenerateFlightPath();
    });
    layer.on('pm:dragend', () => {
        clearRouteLayer();
        updateMeasuredAreaFromPolygon();
        maybeAutoGenerateFlightPath();
    });

    updateMeasuredAreaFromPolygon();
    updateMapControls();
    maybeAutoGenerateFlightPath();
}

function clearMissionGeometry() {
    removeLayer(missionState.takeoffMarker);
    removeLayer(missionState.landingMarker);
    removeLayer(missionState.areaPolygon);
    clearRouteLayer();

    missionState.takeoffMarker = null;
    missionState.landingMarker = null;
    missionState.areaPolygon = null;
    missionState.measuredAreaSqM = null;
    missionState.plannedPathLatLngs = [];

    clearPointMode();
    updateMeasuredAreaDisplays();
    updateMapControls();
    setMapStatus('Mission geometry cleared.');
}

function removeLayer(layer) {
    if (!layer || !mapInstance) {
        return;
    }

    if (missionState.featureGroup && missionState.featureGroup.hasLayer(layer)) {
        missionState.featureGroup.removeLayer(layer);
        return;
    }

    if (mapInstance.hasLayer(layer)) {
        mapInstance.removeLayer(layer);
    }
}

function clearRouteLayer() {
    removeLayer(missionState.routeLayer);
    missionState.routeLayer = null;
    missionState.plannedPathLatLngs = [];
    updateExportButtons(false);
}

function regenerateFlightPathIfReady() {
    if (isMissionReady()) {
        generateFlightPath();
    }
}

function maybeAutoGenerateFlightPath() {
    if (isMissionReady()) {
        generateFlightPath();
    }
}

function isMissionReady() {
    return Boolean(
        missionState.currentMission &&
        missionState.takeoffMarker &&
        missionState.landingMarker &&
        missionState.areaPolygon
    );
}

function generateFlightPath(options = {}) {
    ensureMapReady();

    if (!missionState.currentMission) {
        setMapStatus('Calculate mission parameters first.');
        return;
    }
    if (!missionState.takeoffMarker || !missionState.landingMarker) {
        setMapStatus('Assign takeoff and landing points.');
        return;
    }
    if (!missionState.areaPolygon) {
        setMapStatus('Draw the mission area polygon.');
        return;
    }

    try {
        clearRouteLayer();

        const polygonLatLngs = getAreaLatLngs();
        const takeoffLatLng = missionState.takeoffMarker.getLatLng();
        const landingLatLng = missionState.landingMarker.getLatLng();
        const result = buildFlightPathLatLngs(
            polygonLatLngs,
            takeoffLatLng,
            landingLatLng,
            missionState.currentMission,
            getFlightAngle()
        );

        missionState.plannedPathLatLngs = result.latLngs;
        missionState.routeLayer = L.polyline(result.latLngs, {
            color: '#fbbf24',
            weight: 4,
            opacity: 0.95,
            dashArray: '10 8'
        }).bindTooltip('Flight Path');
        missionState.featureGroup.addLayer(missionState.routeLayer);

        const routeLengthKm = measurePathMeters(result.latLngs) / 1000;
        updateExportButtons(true);
        updateMapControls();

        const bounds = L.latLngBounds(result.latLngs);
        if (bounds.isValid()) {
            mapInstance.fitBounds(bounds.pad(0.18));
        }

        if (!options.silent) {
            setMapStatus(`Flight path generated: ${result.sweepLineCount} lines, ${routeLengthKm.toFixed(2)} km.`);
        }
    } catch (error) {
        clearRouteLayer();
        updateMapControls();
        setMapStatus(`Flight path error: ${error.message}`);
        console.error('Flight path generation failed:', error);
    }
}

function buildFlightPathLatLngs(polygonLatLngs, takeoffLatLng, landingLatLng, mission, angleDeg) {
    if (!polygonLatLngs || polygonLatLngs.length < 3) {
        throw new Error('Polygon must have at least three vertices.');
    }

    const lineSpacingM = Number(mission.lineSpacingM);
    if (!Number.isFinite(lineSpacingM) || lineSpacingM <= 0) {
        throw new Error('Line spacing must be positive.');
    }

    const projection = createLocalProjection([...polygonLatLngs, takeoffLatLng, landingLatLng]);
    const angleRad = (Number.isFinite(angleDeg) ? angleDeg : 0) * Math.PI / 180;
    const rotatedPolygon = polygonLatLngs.map(latLng => rotatePoint(projection.toXY(latLng), -angleRad));
    const sweepLines = createSweepLineSegments(rotatedPolygon, lineSpacingM);

    if (sweepLines.length === 0) {
        throw new Error('No flight line fits inside the polygon.');
    }

    let reverseDirection = false;
    const sweepPoints = [];

    sweepLines.forEach(line => {
        const orderedSegments = reverseDirection
            ? [...line.segments].sort((a, b) => b.x1 - a.x1)
            : [...line.segments].sort((a, b) => a.x1 - b.x1);

        orderedSegments.forEach(segment => {
            const start = reverseDirection
                ? { x: segment.x2, y: line.y }
                : { x: segment.x1, y: line.y };
            const end = reverseDirection
                ? { x: segment.x1, y: line.y }
                : { x: segment.x2, y: line.y };

            addPointIfDistinct(sweepPoints, start);
            addPointIfDistinct(sweepPoints, end);
        });

        reverseDirection = !reverseDirection;
    });

    if (sweepPoints.length < 2) {
        throw new Error('Polygon is too small for the selected line spacing.');
    }

    const sweepLatLngs = sweepPoints.map(point => {
        const unrotated = rotatePoint(point, angleRad);
        return projection.toLatLng(unrotated);
    });

    const forwardRoute = [takeoffLatLng, ...sweepLatLngs, landingLatLng];
    const reverseRoute = [takeoffLatLng, ...sweepLatLngs.slice().reverse(), landingLatLng];
    const selectedRoute = measurePathMeters(reverseRoute) < measurePathMeters(forwardRoute)
        ? reverseRoute
        : forwardRoute;

    return {
        latLngs: selectedRoute,
        sweepLineCount: sweepLines.length
    };
}

function createSweepLineSegments(polygon, spacingM) {
    const yValues = polygon.map(point => point.y);
    const minY = Math.min(...yValues);
    const maxY = Math.max(...yValues);
    const height = maxY - minY;
    const sweepYValues = [];

    if (height <= spacingM) {
        sweepYValues.push((minY + maxY) / 2);
    } else {
        for (let y = minY + spacingM / 2; y < maxY; y += spacingM) {
            sweepYValues.push(y);
        }
        if (sweepYValues.length === 0) {
            sweepYValues.push((minY + maxY) / 2);
        }
    }

    return sweepYValues
        .map(y => ({
            y,
            segments: getHorizontalIntersections(polygon, y)
        }))
        .filter(line => line.segments.length > 0);
}

function getHorizontalIntersections(polygon, y) {
    const xs = [];

    for (let index = 0; index < polygon.length; index += 1) {
        const current = polygon[index];
        const next = polygon[(index + 1) % polygon.length];
        const crosses = (current.y <= y && next.y > y) || (next.y <= y && current.y > y);

        if (crosses) {
            const ratio = (y - current.y) / (next.y - current.y);
            xs.push(current.x + ratio * (next.x - current.x));
        }
    }

    xs.sort((a, b) => a - b);

    const segments = [];
    for (let index = 0; index < xs.length - 1; index += 2) {
        const x1 = xs[index];
        const x2 = xs[index + 1];
        if (Number.isFinite(x1) && Number.isFinite(x2) && x2 - x1 > 0.5) {
            segments.push({ x1, x2 });
        }
    }

    return segments;
}

function createLocalProjection(latLngs) {
    const lat0 = latLngs.reduce((sum, latLng) => sum + latLng.lat, 0) / latLngs.length * Math.PI / 180;
    const lng0 = latLngs.reduce((sum, latLng) => sum + latLng.lng, 0) / latLngs.length * Math.PI / 180;
    const cosLat0 = Math.cos(lat0);

    return {
        toXY(latLng) {
            const latRad = latLng.lat * Math.PI / 180;
            const lngRad = latLng.lng * Math.PI / 180;
            return {
                x: EARTH_RADIUS_M * (lngRad - lng0) * cosLat0,
                y: EARTH_RADIUS_M * (latRad - lat0)
            };
        },
        toLatLng(point) {
            const lat = (point.y / EARTH_RADIUS_M + lat0) * 180 / Math.PI;
            const lng = (point.x / (EARTH_RADIUS_M * cosLat0) + lng0) * 180 / Math.PI;
            return L.latLng(lat, lng);
        }
    };
}

function rotatePoint(point, angleRad) {
    const cos = Math.cos(angleRad);
    const sin = Math.sin(angleRad);
    return {
        x: point.x * cos - point.y * sin,
        y: point.x * sin + point.y * cos
    };
}

function addPointIfDistinct(points, point) {
    const previous = points[points.length - 1];
    if (!previous || Math.hypot(previous.x - point.x, previous.y - point.y) > 0.1) {
        points.push(point);
    }
}

function getAreaLatLngs() {
    let latLngs = missionState.areaPolygon.getLatLngs();
    while (Array.isArray(latLngs[0])) {
        latLngs = latLngs[0];
    }
    return latLngs;
}

function getFlightAngle() {
    const angleInput = document.getElementById('mapFlightAngle');
    const inputValue = angleInput ? parseFloat(angleInput.value) : NaN;
    if (Number.isFinite(inputValue)) {
        return inputValue;
    }
    return Number(missionState.currentMission?.flightDirectionDeg) || 0;
}

function setFlightAngleInput(angleDeg) {
    const angleInput = document.getElementById('mapFlightAngle');
    if (angleInput && document.activeElement !== angleInput) {
        angleInput.value = Number(angleDeg || 0).toFixed(0);
    }
}

function measurePathMeters(latLngs) {
    let total = 0;
    for (let index = 1; index < latLngs.length; index += 1) {
        total += latLngs[index - 1].distanceTo(latLngs[index]);
    }
    return total;
}

function updateMapMissionSummary() {
    const summary = document.getElementById('mapMissionSummary');
    if (!summary) {
        return;
    }

    const mission = missionState.currentMission;
    if (!mission) {
        summary.textContent = 'No mission parameters calculated.';
        return;
    }

    summary.innerHTML = `
        <strong>${mission.sourceLabel || 'Mission Parameters'}</strong>
        <span>GSD: ${formatNumber(mission.gsdCm, 2)} cm/px | Height: ${formatNumber(mission.heightM, 1)} m</span>
        <span>Speed: ${formatNumber(mission.speedMps, 1)} m/s | Line spacing: ${formatNumber(mission.lineSpacingM, 2)} m</span>
        <span>Planned lines: ${formatNumber(mission.lineCount, 0)} | Duration: ${formatNumber(mission.durationMin, 1)} min</span>
    `;
}

function updateMapControls() {
    const generateButton = document.getElementById('btnGeneratePath');
    if (generateButton) {
        generateButton.disabled = !isMissionReady();
    }

    updateToolButtonState();
    updateExportButtons(missionState.plannedPathLatLngs.length > 0);
}

function updateToolButtonState() {
    const takeoffButton = document.getElementById('btnSetTakeoff');
    const landingButton = document.getElementById('btnSetLanding');

    if (takeoffButton) {
        takeoffButton.classList.toggle('active', missionState.activePointMode === 'takeoff');
    }
    if (landingButton) {
        landingButton.classList.toggle('active', missionState.activePointMode === 'landing');
    }
}

function updateExportButtons(isEnabled) {
    const kmlButton = document.getElementById('btnDownloadKml');
    const kmzButton = document.getElementById('btnDownloadKmz');

    if (kmlButton) {
        kmlButton.disabled = !isEnabled;
    }
    if (kmzButton) {
        kmzButton.disabled = !isEnabled;
    }
}

function setMapStatus(message) {
    const status = document.getElementById('mapStatus');
    if (status) {
        status.textContent = message;
    }
}

function formatNumber(value, digits) {
    const number = Number(value);
    return Number.isFinite(number) ? number.toFixed(digits) : '--';
}

function downloadMissionKML() {
    try {
        const kml = buildMissionKML();
        downloadBlob(
            new Blob([kml], { type: 'application/vnd.google-earth.kml+xml' }),
            `${buildExportName()}.kml`
        );
        setMapStatus('KML export ready.');
    } catch (error) {
        setMapStatus(`KML export error: ${error.message}`);
    }
}

async function downloadMissionKMZ() {
    try {
        if (typeof JSZip === 'undefined') {
            throw new Error('JSZip did not load.');
        }

        const zip = new JSZip();
        zip.file('doc.kml', buildMissionKML());
        const blob = await zip.generateAsync({
            type: 'blob',
            compression: 'DEFLATE'
        });

        downloadBlob(blob, `${buildExportName()}.kmz`);
        setMapStatus('KMZ export ready.');
    } catch (error) {
        setMapStatus(`KMZ export error: ${error.message}`);
    }
}

function buildMissionKML() {
    if (!missionState.plannedPathLatLngs.length) {
        throw new Error('Generate a flight path first.');
    }

    const mission = missionState.currentMission || {};
    const altitude = Number(mission.heightM) || 0;
    const areaLatLngs = getAreaLatLngs();
    const closedAreaLatLngs = [...areaLatLngs, areaLatLngs[0]];
    const takeoff = missionState.takeoffMarker.getLatLng();
    const landing = missionState.landingMarker.getLatLng();
    const missionName = 'AeroPlan Mission';

    return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <name>${escapeXml(missionName)}</name>
    <Style id="takeoffStyle">
      <IconStyle><color>ff22a316</color><scale>1.1</scale><Icon><href>http://maps.google.com/mapfiles/kml/paddle/grn-circle.png</href></Icon></IconStyle>
    </Style>
    <Style id="landingStyle">
      <IconStyle><color>ff2626dc</color><scale>1.1</scale><Icon><href>http://maps.google.com/mapfiles/kml/paddle/red-circle.png</href></Icon></IconStyle>
    </Style>
    <Style id="areaStyle">
      <LineStyle><color>ffc78402</color><width>3</width></LineStyle>
      <PolyStyle><color>3309a5e9</color></PolyStyle>
    </Style>
    <Style id="pathStyle">
      <LineStyle><color>ff24bffb</color><width>4</width></LineStyle>
    </Style>
    <Folder>
      <name>Mission Features</name>
      <Placemark>
        <name>Takeoff</name>
        <styleUrl>#takeoffStyle</styleUrl>
        <Point><coordinates>${formatKmlCoordinate(takeoff, 0)}</coordinates></Point>
      </Placemark>
      <Placemark>
        <name>Landing</name>
        <styleUrl>#landingStyle</styleUrl>
        <Point><coordinates>${formatKmlCoordinate(landing, 0)}</coordinates></Point>
      </Placemark>
      <Placemark>
        <name>Mission Area</name>
        <styleUrl>#areaStyle</styleUrl>
        <Polygon>
          <outerBoundaryIs>
            <LinearRing>
              <coordinates>${closedAreaLatLngs.map(latLng => formatKmlCoordinate(latLng, 0)).join(' ')}</coordinates>
            </LinearRing>
          </outerBoundaryIs>
        </Polygon>
      </Placemark>
      <Placemark>
        <name>Flight Path</name>
        <styleUrl>#pathStyle</styleUrl>
        <ExtendedData>
          <Data name="Planner"><value>${escapeXml(mission.sourceLabel || '')}</value></Data>
          <Data name="GSD cm per px"><value>${formatNumber(mission.gsdCm, 2)}</value></Data>
          <Data name="Height m"><value>${formatNumber(mission.heightM, 1)}</value></Data>
          <Data name="Speed mps"><value>${formatNumber(mission.speedMps, 1)}</value></Data>
          <Data name="Line spacing m"><value>${formatNumber(mission.lineSpacingM, 2)}</value></Data>
          <Data name="Duration min"><value>${formatNumber(mission.durationMin, 1)}</value></Data>
        </ExtendedData>
        <LineString>
          <tessellate>1</tessellate>
          <altitudeMode>relativeToGround</altitudeMode>
          <coordinates>${missionState.plannedPathLatLngs.map(latLng => formatKmlCoordinate(latLng, altitude)).join(' ')}</coordinates>
        </LineString>
      </Placemark>
    </Folder>
  </Document>
</kml>`;
}

function formatKmlCoordinate(latLng, altitude) {
    return `${latLng.lng.toFixed(8)},${latLng.lat.toFixed(8)},${Number(altitude).toFixed(2)}`;
}

function escapeXml(value) {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}

function buildExportName() {
    const timestamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    return `aeroplan-mission-${timestamp}`;
}

function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
}
