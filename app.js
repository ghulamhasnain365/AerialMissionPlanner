/**
 * AeroPlan App SPA Logic
 */

let mapInstance = null;

document.addEventListener('DOMContentLoaded', () => {
    // Navigation routing logic
    const navItems = document.querySelectorAll('.nav-item');
    const pageViews = document.querySelectorAll('.page-view');

    navItems.forEach(item => {
        item.addEventListener('click', (e) => {
            e.preventDefault();
            
            const targetId = item.getAttribute('data-target');
            
            // Remove active class from all links and views
            navItems.forEach(nav => nav.classList.remove('active'));
            pageViews.forEach(view => view.classList.remove('active'));

            // Add active class to clicked link and selected view
            item.classList.add('active');
            const targetView = document.getElementById(targetId);
            if (targetView) {
                targetView.classList.add('active');
            }

            // Map init fix when navigating to the Webmap tab
            if (targetId === 'page-webmap') {
                if (!mapInstance) {
                    initMap();
                } else {
                    // Leaflet re-size workaround for hidden maps
                    setTimeout(() => {
                        mapInstance.invalidateSize();
                    }, 100);
                }
            }
            
            // If navigating to home, update URL hash (simple routing)
            const route = targetId.replace('page-', '');
            history.pushState(null, null, `#${route}`);
        });
    });

    // Handle initial load hash router
    const currentHash = window.location.hash.replace('#', '');
    if (currentHash) {
        const matchingLink = document.querySelector(`.nav-item[data-target="page-${currentHash}"]`);
        if (matchingLink) {
            matchingLink.click();
        }
    }
});

/**
 * Initializes the Leaflet map (based on leaflet_starter.html coords)
 */
function initMap() {
    // Using IST, Islamabad Coordinates
    mapInstance = L.map('leaflet-map-container').setView([33.5184, 73.1665], 13);

    // Switched to Esri World Imagery (Satellite) to avoid OpenStreetMap local file limits
    L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
        maxZoom: 19,
        attribution: 'Tiles &copy; Esri &mdash; Source: Esri, i-cubed, USDA, USGS, AEX, GeoEye, Getmapping, Aerogrid, IGN, IGP, UPR-EGP, and the GIS User Community'
    }).addTo(mapInstance);

    const marker = L.marker([33.5184, 73.1665]).addTo(mapInstance)
        .bindPopup('<b>Start Location</b><br />Institute of Space Technology (IST), Islamabad.').openPopup();

    const circle = L.circle([33.520, 73.170], {
        color: 'red',
        fillColor: '#f03',
        fillOpacity: 0.5,
        radius: 500
    }).addTo(mapInstance).bindPopup('Mission Area');

    const polygon = L.polygon([
        [33.525, 73.160],
        [33.530, 73.165],
        [33.525, 73.170]
    ]).addTo(mapInstance).bindPopup('No Fly Zone');

    const baseStation = L.popup()
        .setLatLng([33.515, 73.160])
        .setContent('Base Station')
        .openOn(mapInstance);

    // Add Geoman Edit Toolbar
    mapInstance.pm.addControls({
        position: 'topleft',
        drawCircleMarker: false,
        drawText: false
    });
}
