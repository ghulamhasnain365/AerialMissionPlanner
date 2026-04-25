// --- HELPER FUNCTIONS (Moved to top level for global scope) ---
function roundToHalf(value) {
    // Rounds a number to the nearest 0.5
    return Math.round(value * 2) / 2;
}

function roundToQuarter(value) {
    // Rounds a number to the nearest 0.25
    return Math.round(value * 4) / 4;
}

function setPlannerMapButton(source, isVisible) {
    const buttonId = source === 'gsd' ? 'btnPlanMapGsd' : 'btnPlanMapTime';
    const button = document.getElementById(buttonId);
    if (button) {
        button.style.display = isVisible ? 'block' : 'none';
    }
}

function hidePlannerMapButtons() {
    setPlannerMapButton('timeArea', false);
    setPlannerMapButton('gsd', false);
}

function publishMissionParameters(source, missionParameters) {
    const mission = {
        ...missionParameters,
        source,
        createdAt: new Date().toISOString()
    };

    window.currentMissionParameters = mission;
    if (typeof window.storeMissionParameters === 'function') {
        window.storeMissionParameters(mission);
    }

    setPlannerMapButton(source, true);
}

// --- CORE JAVASCRIPT LOGIC ---
class DroneMappingCalculator {

    // --- Constants ---
    static TURN_BUFFER_FACTOR = 1.05; // Added buffer for turns in path calculation
    static ASPECT_RATIO = 1.5; // Assumed Length:Width ratio for area calculation
    // Minimum required overlaps (used for highlighting results, not strict enforcement yet)
    static MIN_FRONT_OVERLAP_FACTOR = 0.745;
    static MIN_SIDE_OVERLAP_FACTOR = 0.795;

    // --- Default Drone Specifications ---
    static DRONE_SPECS = {
        'dji_air_2s': {
            focal_length: 9.0,         // mm
            sensor_width: 13.1,        // mm
            sensor_length: 8.8,        // mm
            pixels_width: 5472,        // pixels
            pixels_length: 3648,       // pixels
            min_shutter_interval_sec: 2.0, // seconds
            min_speed_mps: 1.0,        // meters per second
            max_speed_mps: 6.0,        // meters per second
            side_overlap_percent: 80,  // %
            front_overlap_percent: 75  // %
        }
        // Add more drone models here if needed
    };

    // --- STATIC CALCULATION FUNCTIONS ---

    /**
     * Calculates the required flight height (H) based on desired GSD.
     * @param {number} gsd_cm - Ground Sample Distance in centimeters per pixel.
     * @param {number} focal_length_mm - Camera focal length in millimeters.
     * @param {number} pixel_pitch_mm - Sensor pixel pitch (size) in millimeters.
     * @returns {number} Flight height in meters.
     */
    static calculateHeight(gsd_cm, focal_length_mm, pixel_pitch_mm) {
        const gsd_m = gsd_cm / 100;
        const focal_length_m = focal_length_mm / 1000;
        const pixel_pitch_m = pixel_pitch_mm / 1000;
        if (pixel_pitch_mm === 0) { throw new Error("Cannot calculate Height: Pixel pitch is zero."); }
        return (gsd_m * focal_length_m) / pixel_pitch_m; // Formula: H = (GSD * f) / pixel_pitch
    }

    /**
     * Calculates the Ground Sample Distance (GSD) based on flight height.
     * @param {number} H - Flight height in meters.
     * @param {number} focal_length_mm - Camera focal length in millimeters.
     * @param {number} pixel_pitch_mm - Sensor pixel pitch (size) in millimeters.
     * @returns {number} GSD in centimeters per pixel.
     */
    static calculateGSD(H, focal_length_mm, pixel_pitch_mm) {
        const focal_length_m = focal_length_mm / 1000;
        const pixel_pitch_m = pixel_pitch_mm / 1000;
        if (focal_length_m === 0) { throw new Error("Cannot calculate GSD: Focal length is zero."); }
        const gsd_m = (H * pixel_pitch_m) / focal_length_m; // Formula: GSD = (H * pixel_pitch) / f
        return gsd_m * 100; // Convert to cm/px
    }

    /**
     * Calculates the actual front overlap achieved based on flight parameters.
     * @param {number} speed_mps - Drone ground speed in meters per second.
     * @param {number} interval_sec - Shutter interval in seconds.
     * @param {number} height_m - Flight height in meters.
     * @param {number} focal_length_mm - Camera focal length in millimeters.
     * @param {number} sensor_height_mm - Sensor dimension along the flight direction (length) in millimeters.
     * @returns {number} Front overlap factor (0 to 1).
     */
    static calculateFrontOverlap(speed_mps, interval_sec, height_m, focal_length_mm, sensor_height_mm) {
        const focal_length_m = focal_length_mm / 1000;
        const sensor_height_m = sensor_height_mm / 1000;
        if (focal_length_m === 0) return 0; // Avoid division by zero
        // Calculate footprint dimension along flight direction
        const footprint_length_m = (sensor_height_m * height_m) / focal_length_m;
        if (footprint_length_m === 0) return 1; // Avoid division by zero, assume 100% overlap if footprint is zero
        // Calculate distance traveled between photos
        const photo_spacing_m = speed_mps * interval_sec;
        // Calculate overlap
        const front_overlap = 1 - (photo_spacing_m / footprint_length_m);
        return Math.max(0, front_overlap); // Ensure overlap is not negative
    }

    /**
     * Calculates the actual side overlap achieved based on flight parameters.
     * @param {number} line_spacing_m - Spacing between flight lines in meters.
     * @param {number} H - Flight height in meters.
     * @param {number} focal_length_mm - Camera focal length in millimeters.
     * @param {number} sensor_width_mm - Sensor dimension perpendicular to flight direction in millimeters.
     * @param {number} sensor_length_mm - Sensor dimension along flight direction in millimeters.
     * @returns {number} Side overlap factor (0 to 1).
     */
    static calculateSideOverlap(line_spacing_m, H, focal_length_mm, sensor_width_mm, sensor_length_mm) {
        // Calculate footprint dimensions first
        const footprint = this.calculateFootprintDimensions(H, focal_length_mm, sensor_width_mm, sensor_length_mm);
        if (footprint.width === 0) return 1; // Avoid division by zero, assume 100% overlap
        // Calculate overlap
        const side_overlap = 1 - (line_spacing_m / footprint.width);
        return Math.max(0, side_overlap); // Ensure overlap is not negative
    }

    /**
     * Calculates the ground footprint dimensions of a single image.
     * @param {number} H - Flight height in meters.
     * @param {number} focal_length_mm - Camera focal length in millimeters.
     * @param {number} sensor_width_mm - Sensor width in millimeters.
     * @param {number} sensor_length_mm - Sensor length in millimeters.
     * @returns {object} Object containing footprint width (m), height (m), area (m^2), and sensor height (mm).
     */
    static calculateFootprintDimensions(H, focal_length_mm, sensor_width_mm, sensor_length_mm) {
        const focal_length_m = focal_length_mm / 1000;
        const sensor_width_m = sensor_width_mm / 1000;
        const sensor_height_m = sensor_length_mm / 1000; // Renamed for clarity (length -> height on ground)

        if (focal_length_m === 0) { throw new Error("Cannot calculate Footprint: Focal length is zero."); }

        // Footprint width corresponds to sensor width
        const footprint_width_m = (sensor_width_m * H) / focal_length_m;
        // Footprint height/length corresponds to sensor length
        const footprint_height_m = (sensor_height_m * H) / focal_length_m;

        return {
            width: footprint_width_m,    // Dimension across track
            height: footprint_height_m,   // Dimension along track
            area: footprint_width_m * footprint_height_m,
            sensor_height_mm: sensor_length_mm // Keep original sensor dim for FO calc if needed
        };
    }

    // --- Suggestion Functions (Used for initial estimates) ---
    /**
     * Suggests a GSD based on target duration and area (using 75% of max speed).
     */
    static getSuggestionGSD(inputs) {
        const {
            target_duration_min, bounding_length_m, bounding_width_m,
            sensor_width_mm, focal_length_mm, pixel_pitch_mm,
            max_speed_mps, side_overlap_factor
        } = inputs;

        const speed_for_suggestion = max_speed_mps * 0.75; // Use a reasonable cruise speed
        const total_path_m = target_duration_min * 60 * speed_for_suggestion;
        const total_flight_track_m = total_path_m / this.TURN_BUFFER_FACTOR; // Estimate track length without turns

        const num_lines_raw = total_flight_track_m / bounding_length_m;
        const num_lines = Math.floor(num_lines_raw); // Need at least 2 lines

        if (num_lines < 2) {
            throw new Error("Duration might be too short for this area/speed.");
        }

        // Estimate required line spacing and footprint width
        const line_spacing_m = bounding_width_m / (num_lines - 1);
        const footprint_width_m = line_spacing_m / (1 - side_overlap_factor);

        // Estimate required height based on footprint width
        const focal_length_m = focal_length_mm / 1000;
        const sensor_width_m = sensor_width_mm / 1000;
        if (sensor_width_m === 0) throw new Error("Sensor width cannot be zero.");
        const suggested_height = (footprint_width_m * focal_length_m) / sensor_width_m;

        // Calculate GSD from the estimated height
        const suggested_gsd = this.calculateGSD(suggested_height, focal_length_mm, pixel_pitch_mm);
        return suggested_gsd;
    }

    /**
     * Suggests a flight duration based on target GSD and area (using 75% of max speed).
     */
    static getSuggestionDuration(inputs) {
        const {
            target_gsd_cm, bounding_length_m, bounding_width_m,
            sensor_width_mm, sensor_length_mm, focal_length_mm, pixel_pitch_mm,
            max_speed_mps, side_overlap_factor
        } = inputs;

        const speed_for_suggestion = max_speed_mps * 0.75; // Use a reasonable cruise speed

        // Calculate height required for the target GSD
        const suggested_height = this.calculateHeight(target_gsd_cm, focal_length_mm, pixel_pitch_mm);
        // Calculate footprint and line spacing at that height
        const footprint = this.calculateFootprintDimensions(suggested_height, focal_length_mm, sensor_width_mm, sensor_length_mm);
        if (footprint.width === 0) throw new Error("Calculated footprint width is zero.");
        const line_spacing = footprint.width * (1 - side_overlap_factor);

        // Estimate number of lines needed
        if (line_spacing <= 0) throw new Error("Line spacing must be positive.");
        const num_lines_raw = bounding_width_m / line_spacing + 1;
        const num_lines = Math.ceil(num_lines_raw);

        // Calculate total path length including turns
        const total_flight_track_m = num_lines * bounding_length_m;
        const total_path_m = total_flight_track_m * this.TURN_BUFFER_FACTOR;

        // Estimate duration
        if (speed_for_suggestion <= 0) throw new Error("Speed for suggestion must be positive.");
        const duration_min = (total_path_m / speed_for_suggestion) / 60;
        return duration_min;
    }

    // --- Main Calculation Logic for Duration-Based Planner ---
    /**
     * Calculates mission parameters optimizing for a target duration.
     * Returns calculated values including potential warnings.
     */
    static runTimeBasedCalculation(inputs) {
        const {
            target_duration_min, bounding_length_m, bounding_width_m,
            sensor_width_mm, sensor_length_mm, focal_length_mm, pixel_pitch_mm,
            min_speed_mps, max_speed_mps,
            side_overlap_factor, front_overlap_factor, min_shutter_interval_cap_sec
        } = inputs;

        // 1. Estimate ideal number of lines based on target duration and MAX speed
        const total_path_m_at_max_speed = target_duration_min * 60 * max_speed_mps;
        const total_flight_track_m = total_path_m_at_max_speed / this.TURN_BUFFER_FACTOR;
        if (bounding_length_m <= 0) throw new Error("Area length must be positive.");
        const num_lines_raw = total_flight_track_m / bounding_length_m;
        const num_lines = Math.floor(num_lines_raw); // Round down initially

        if (num_lines < 2) {
            throw new Error(`Duration/Max Speed too low for area (needs >= 2 lines).`);
        }

        // 2. Calculate initial required Height based on this number of lines
        const line_spacing_m = bounding_width_m / (num_lines - 1);
        const footprint_width_m = line_spacing_m / (1 - side_overlap_factor);
        const focal_length_m = focal_length_mm / 1000;
        const sensor_width_m = sensor_width_mm / 1000;
        if (sensor_width_m === 0) throw new Error("Sensor width cannot be zero.");
        const required_height = (footprint_width_m * focal_length_m) / sensor_width_m;

        // 3. Calculate initial required Speed based on Height and fixed Shutter Interval/FO
        const footprint = this.calculateFootprintDimensions(required_height, focal_length_mm, sensor_width_mm, sensor_length_mm);
        const photo_spacing_m = footprint.height * (1 - front_overlap_factor);
        if (min_shutter_interval_cap_sec <= 0) throw new Error("Shutter interval must be positive.");
        let required_speed = photo_spacing_m / min_shutter_interval_cap_sec;

        // 4. Constrain the required speed within Min/Max limits
        let speed_warning_text = '';
        let speed_color = '#333'; // Default color
        if (required_speed < min_speed_mps) {
            required_speed = min_speed_mps;
            // WARNING: Flying faster than needed *reduces* overlap
            speed_warning_text = `WARNING: Capped at Min Speed. FO will be *lower*.`;
            speed_color = 'red';
        } else if (required_speed > max_speed_mps) {
            required_speed = max_speed_mps;
            // NOTE: Flying slower than needed *increases* overlap (safe)
            speed_warning_text = `NOTE: Capped at Max Speed. FO will be *higher*.`;
            speed_color = 'orange';
        }

        // 5. Apply rounding to key parameters (Height, Speed, Line Spacing)
        const roundedHeight = roundToHalf(required_height);
        const roundedSpeed = roundToHalf(required_speed); // Use the constrained speed
        const roundedLineSpacing = roundToQuarter(line_spacing_m);

        // 6. Recalculate everything based on these FINAL rounded/constrained values
        const finalGSD = this.calculateGSD(roundedHeight, focal_length_mm, pixel_pitch_mm);

        // Recalculate overlaps based on final rounded values
        const finalAchievedFO = this.calculateFrontOverlap(
            roundedSpeed, min_shutter_interval_cap_sec, roundedHeight, focal_length_mm, sensor_length_mm
        ) * 100;
        const finalAchievedSO = this.calculateSideOverlap(
            roundedLineSpacing, roundedHeight, focal_length_mm, sensor_width_mm, sensor_length_mm
        ) * 100;

        // Recalculate number of lines based on rounded spacing
        if (roundedLineSpacing <= 0) throw new Error("Rounded line spacing must be positive.");
        const finalNumLinesRaw = bounding_width_m / roundedLineSpacing + 1;
        const finalNumLines = Math.ceil(finalNumLinesRaw); // Round up lines needed

        // Recalculate path length and final duration
        const finalTotalFlightTrack = finalNumLines * bounding_length_m;
        const finalTotalPath = finalTotalFlightTrack * this.TURN_BUFFER_FACTOR;
        if (roundedSpeed <= 0) throw new Error("Rounded speed must be positive.");
        const finalDurationMin = (finalTotalPath / roundedSpeed) / 60;

        // Recalculate final footprint dimensions
        const finalFootprint = this.calculateFootprintDimensions(
            roundedHeight, focal_length_mm, sensor_width_mm, sensor_length_mm
        );

        // Return all calculated final values
        return {
            finalGSD: finalGSD,
            roundedHeight: roundedHeight,
            roundedSpeed: roundedSpeed, // This is the final, constrained, rounded speed
            speed_color: speed_color,
            speed_warning_text: speed_warning_text, // Pass the warning text out
            footprint: finalFootprint,
            finalShutterInterval: min_shutter_interval_cap_sec, // Shutter interval was fixed
            finalAchievedFO: finalAchievedFO,
            roundedLineSpacing: roundedLineSpacing,
            finalAchievedSO: finalAchievedSO,
            finalTotalPath: finalTotalPath,
            finalNumLines: finalNumLines,
            finalDurationMin: finalDurationMin // The duration resulting from calculations
        };
    }

} // *** END OF CLASS DroneMappingCalculator ***


// --- UI Interaction & Event Handling Functions ---

/**
 * Switches the visible calculator view (Duration-based or GSD-based).
 * @param {string} calculatorName - 'timeArea' or 'gsd'.
 */
function switchCalculator(calculatorName) {
    const timeAreaDiv = document.getElementById('timeAreaCalculator');
    const gsdDiv = document.getElementById('gsdCalculator');
    const btnTimeArea = document.getElementById('btnTimeArea');
    const btnGSD = document.getElementById('btnGSD');

    // Hide results when switching
    document.getElementById('results').style.display = 'none';
    document.getElementById('gsdResults').style.display = 'none';
    hidePlannerMapButtons();
    // Hide error messages
    document.getElementById('errorMessage').style.display = 'none';
    document.getElementById('gsdErrorMessage').style.display = 'none';


    if (calculatorName === 'timeArea') {
        timeAreaDiv.style.display = 'block';
        gsdDiv.style.display = 'none';
        btnTimeArea.classList.add('active');
        btnGSD.classList.remove('active');
        const plannerTitle = document.querySelector('.planner-title');
        if (plannerTitle) plannerTitle.innerHTML = 'Duration-based Mission Planner';
        suggestGSD(); // Update suggestion on switch
    } else if (calculatorName === 'gsd') {
        syncSpecsToGSDForm(); // Copy sensor specs from the other form

        timeAreaDiv.style.display = 'none';
        gsdDiv.style.display = 'block';
        btnTimeArea.classList.remove('active');
        btnGSD.classList.add('active');
        const plannerTitle = document.querySelector('.planner-title');
        if (plannerTitle) plannerTitle.innerHTML = 'GSD-based Mission Planner';

        suggestFlightDuration(); // Update suggestion on switch
    }
}

/**
 * Copies sensor specification values from the Duration-based form
 * to the GSD-based form when switching.
 */
function syncSpecsToGSDForm() {
    const mapping = {
        'drone_model': 'gsd_drone_model',
        'focal_length': 'gsd_focal_length',
        'sensor_width': 'gsd_sensor_width',
        'sensor_length': 'gsd_sensor_length',
        'sensor_pixels_width': 'gsd_sensor_pixels_width',
        'sensor_pixels_length': 'gsd_sensor_pixels_length', // Corrected ID
        'min_shutter_interval': 'gsd_min_shutter_interval',
        'min_speed': 'gsd_min_speed',
        'max_speed': 'gsd_max_speed',
        'side_overlap': 'gsd_side_overlap',
        'front_overlap': 'gsd_front_overlap',
        // 'flight_direction' is fixed at 0, no need to sync
        // Uncertainty values are specific to each planner, no need to sync
    };

    for (const srcId in mapping) {
        const destId = mapping[srcId];
        try {
            const srcElement = document.getElementById(srcId);
            const destElement = document.getElementById(destId);

            if (srcElement && destElement) {
                destElement.value = srcElement.value;
                // Sync disabled state as well if needed (e.g., when a preset is selected)
                destElement.disabled = srcElement.disabled;
            }
        } catch (e) {
            console.error(`Error syncing element ${srcId} to ${destId}:`, e);
        }
    }
    // Also copy area value for convenience
     try {
        const areaSrc = document.getElementById('area_hectares');
        const areaDest = document.getElementById('gsd_area_hectares');
        if (areaSrc && areaDest) {
            areaDest.value = areaSrc.value;
        }
     } catch(e){
         console.error("Error syncing area:", e);
     }
}


/**
 * Loads drone specifications into the form fields based on the selected model.
 * Disables fields if a preset is chosen, enables them for 'custom'.
 * Applies specs to both calculator forms.
 */
function loadDroneSpecs() {
    const model = document.getElementById('drone_model').value; // Get model from the currently active form
    const isCustom = model === 'custom';
    const specs = DroneMappingCalculator.DRONE_SPECS[model]; // Get specs if it's a preset

    // Helper function to apply specs to a form (identified by prefix)
    const applySpecs = (prefix = '') => {
        const inputs = {
            focal_length: document.getElementById(prefix + 'focal_length'),
            sensor_width: document.getElementById(prefix + 'sensor_width'),
            sensor_length: document.getElementById(prefix + 'sensor_length'),
            pixels_width: document.getElementById(prefix + 'sensor_pixels_width'),
            pixels_length: document.getElementById(prefix + 'sensor_pixels_length'),
            min_shutter_interval: document.getElementById(prefix + 'min_shutter_interval'),
            min_speed: document.getElementById(prefix + 'min_speed'),
            max_speed: document.getElementById(prefix + 'max_speed'),
            side_overlap: document.getElementById(prefix + 'side_overlap'),
            front_overlap: document.getElementById(prefix + 'front_overlap'),
            model_select: document.getElementById(prefix + 'drone_model') // The dropdown itself
        };

        for (const key in inputs) {
             try {
                if (inputs[key] && key !== 'model_select') {
                    // Enable/disable based on 'custom' selection
                    inputs[key].disabled = !isCustom;
                    // If it's a preset and specs exist, load the values
                    if (!isCustom && specs) {
                        switch (key) {
                            case 'focal_length': inputs[key].value = specs.focal_length; break;
                            case 'sensor_width': inputs[key].value = specs.sensor_width; break;
                            case 'sensor_length': inputs[key].value = specs.sensor_length; break;
                            case 'pixels_width': inputs[key].value = specs.pixels_width; break;
                            case 'pixels_length': inputs[key].value = specs.pixels_length; break;
                            case 'min_shutter_interval': inputs[key].value = specs.min_shutter_interval_sec; break;
                            case 'min_speed': inputs[key].value = specs.min_speed_mps; break;
                            case 'max_speed': inputs[key].value = specs.max_speed_mps; break;
                            case 'side_overlap': inputs[key].value = specs.side_overlap_percent; break;
                            case 'front_overlap': inputs[key].value = specs.front_overlap_percent; break;
                        }
                    }
                } else if (inputs[key] && inputs[key].value !== model) {
                    // Ensure the dropdown itself reflects the chosen model
                    inputs[key].value = model;
                }
             } catch (e) {
                 console.error(`Error applying spec for ${key} with prefix ${prefix}:`, e);
             }
        }
    };

    // Apply to both forms
    applySpecs();      // Duration-based form (no prefix)
    applySpecs('gsd_'); // GSD-based form (prefix 'gsd_')

    // Update suggestions after loading new specs
    suggestGSD();
    suggestFlightDuration();
}

/**
 * Handler function for when the drone model is changed in the GSD form.
 * It updates the model selection in the (hidden) duration form and calls loadDroneSpecs.
 */
function gsdLoadDroneSpecs() {
    const model = document.getElementById('gsd_drone_model').value;
     try {
        document.getElementById('drone_model').value = model; // Sync selection to the other form
        loadDroneSpecs(); // Reload specs for both forms
     } catch (e) {
         console.error("Error in gsdLoadDroneSpecs:", e);
     }
}

// --- Suggestion Update Functions ---

/**
 * Updates the suggested flight duration text in the GSD calculator UI.
 */
function suggestFlightDuration() {
    const suggestionBox = document.getElementById('gsd_duration_suggestion');
    if (!suggestionBox) return; // Exit if element not found

    try {
        const areaInput = document.getElementById('gsd_area_hectares');
        const gsdInput = document.getElementById('target_gsd'); // Target GSD input

        const area_ha = parseFloat(areaInput.value);
        const gsd_cm = parseFloat(gsdInput.value);

        // Basic validation for suggestion inputs
        if (isNaN(area_ha) || area_ha <= 0 || isNaN(gsd_cm) || gsd_cm <= 0) {
            suggestionBox.innerHTML = `Enter Area and Target GSD for duration estimate.`;
            return;
        }

        const area_sq_m = area_ha * 10000;

        // Gather necessary inputs for the suggestion calculation
        const inputs = {
            target_gsd_cm: gsd_cm,
            bounding_width_m: Math.sqrt(area_sq_m / DroneMappingCalculator.ASPECT_RATIO),
            bounding_length_m: Math.sqrt(area_sq_m / DroneMappingCalculator.ASPECT_RATIO) * DroneMappingCalculator.ASPECT_RATIO,
            focal_length_mm: parseFloat(document.getElementById('gsd_focal_length').value) || 0,
            sensor_width_mm: parseFloat(document.getElementById('gsd_sensor_width').value) || 0,
            sensor_length_mm: parseFloat(document.getElementById('gsd_sensor_length').value) || 0,
            sensor_pixels_width: parseInt(document.getElementById('gsd_sensor_pixels_width').value, 10) || 1,
            max_speed_mps: parseFloat(document.getElementById('gsd_max_speed').value) || 1.0,
            side_overlap_factor: (parseFloat(document.getElementById('gsd_side_overlap').value) || 80) / 100 // Use default if invalid
        };
        // Calculate pixel pitch, handle potential division by zero
        inputs.pixel_pitch_mm = inputs.sensor_pixels_width > 0 ? (inputs.sensor_width_mm / inputs.sensor_pixels_width) : 0;

        // Perform calculation within a try...catch
        const duration_min = DroneMappingCalculator.getSuggestionDuration(inputs);
        suggestionBox.innerHTML = `Suggestion: Estimated time is ~<strong>${duration_min.toFixed(1)} minutes</strong> (at 75% speed).`;

    } catch (e) {
        // Display calculation errors in the suggestion box
        suggestionBox.innerHTML = `Suggestion Error: ${e.message}`;
        console.error("Error suggesting duration:", e);
    }
}

/**
 * Updates the suggested GSD text in the Duration-based calculator UI.
 */
function suggestGSD() {
    const suggestionBox = document.getElementById('time_gsd_suggestion');
    if (!suggestionBox) return; // Exit if element not found

    try {
        const durationInput = document.getElementById('target_duration');
        const areaInput = document.getElementById('area_hectares');

        const duration_min = parseFloat(durationInput.value);
        const area_ha = parseFloat(areaInput.value);

        // Basic validation for suggestion inputs
        if (isNaN(area_ha) || area_ha <= 0 || isNaN(duration_min) || duration_min <= 0) {
            suggestionBox.innerHTML = `Enter Duration and Area for GSD estimate.`;
            return;
        }

        const area_sq_m = area_ha * 10000;

        // Gather necessary inputs for the suggestion calculation
        const inputs = {
            target_duration_min: duration_min,
            bounding_width_m: Math.sqrt(area_sq_m / DroneMappingCalculator.ASPECT_RATIO),
            bounding_length_m: Math.sqrt(area_sq_m / DroneMappingCalculator.ASPECT_RATIO) * DroneMappingCalculator.ASPECT_RATIO,
            focal_length_mm: parseFloat(document.getElementById('focal_length').value) || 0,
            sensor_width_mm: parseFloat(document.getElementById('sensor_width').value) || 0,
            // sensor_length_mm is not needed for GSD suggestion based on duration
            sensor_pixels_width: parseInt(document.getElementById('sensor_pixels_width').value, 10) || 1,
            max_speed_mps: parseFloat(document.getElementById('max_speed').value) || 1.0,
            side_overlap_factor: (parseFloat(document.getElementById('side_overlap').value) || 80) / 100 // Use default if invalid
        };
        // Calculate pixel pitch, handle potential division by zero
        inputs.pixel_pitch_mm = inputs.sensor_pixels_width > 0 ? (inputs.sensor_width_mm / inputs.sensor_pixels_width) : 0;

        // Perform calculation within a try...catch
        const suggested_gsd = DroneMappingCalculator.getSuggestionGSD(inputs);
        suggestionBox.innerHTML = `Suggestion: Expected GSD is approx. <strong>${suggested_gsd.toFixed(1)} cm/px</strong> (at 75% speed).`;

    } catch (e) {
        // Display calculation errors in the suggestion box
        suggestionBox.innerHTML = `Suggestion Error: ${e.message}`;
        console.error("Error suggesting GSD:", e);
    }
}

// --- Main Calculation Trigger Functions ---

/**
 * Main function for the Duration-based calculator.
 * Reads inputs, validates, calls calculation logic, and displays results or errors.
 */
function calculateMission() {
    const input_area_ha = parseFloat(document.getElementById('area_hectares').value);
    const input_duration_unc = parseFloat(document.getElementById('target_duration_unc').value) || 0; // Read uncertainty, default 0
    const area_sq_m = input_area_ha * 10000;

    const errorBox = document.getElementById('errorMessage');
    const resultsBox = document.getElementById('results');
    errorBox.style.display = 'none'; // Clear previous errors/warnings
    resultsBox.style.display = 'none';
    setPlannerMapButton('timeArea', false);

    // --- Input Gathering ---
     const inputs = {
        target_duration_min: parseFloat(document.getElementById('target_duration').value),
        bounding_length_m: 0, // Will be calculated
        bounding_width_m: 0,  // Will be calculated
        focal_length_mm: parseFloat(document.getElementById('focal_length').value),
        sensor_width_mm: parseFloat(document.getElementById('sensor_width').value),
        sensor_length_mm: parseFloat(document.getElementById('sensor_length').value),
        sensor_pixels_width: parseInt(document.getElementById('sensor_pixels_width').value, 10),
        max_speed_mps: parseFloat(document.getElementById('max_speed').value),
        min_speed_mps: parseFloat(document.getElementById('min_speed').value),
        min_shutter_interval_cap_sec: parseFloat(document.getElementById('min_shutter_interval').value),
        side_overlap_factor: parseFloat(document.getElementById('side_overlap').value) / 100,
        front_overlap_factor: parseFloat(document.getElementById('front_overlap').value) / 100
    };

    // --- Validation ---
    let errorMessages = [];
    if (isNaN(input_area_ha) || input_area_ha <= 0) errorMessages.push("Area must be positive.");
    if (isNaN(inputs.target_duration_min) || inputs.target_duration_min <= 0) errorMessages.push("Target duration must be positive.");
    if (isNaN(input_duration_unc) || input_duration_unc < 0) errorMessages.push("Duration uncertainty must be non-negative.");
    if (inputs.min_speed_mps <= 0 || inputs.max_speed_mps <= 0 || inputs.min_speed_mps > inputs.max_speed_mps) errorMessages.push("Invalid speed limits (Min > 0, Min <= Max).");
    if (inputs.min_shutter_interval_cap_sec <=0) errorMessages.push("Shutter interval must be positive.");
    if (inputs.side_overlap_factor < 0 || inputs.side_overlap_factor >= 1) errorMessages.push("Side overlap must be between 0% and 100%.");
     if (inputs.front_overlap_factor < 0 || inputs.front_overlap_factor >= 1) errorMessages.push("Front overlap must be between 0% and 100%.");

    for (const key of ['focal_length_mm', 'sensor_width_mm', 'sensor_length_mm', 'sensor_pixels_width']) {
        if (isNaN(inputs[key]) || inputs[key] <= 0) {
            errorMessages.push(`Valid positive ${key.replace('_mm','').replace('_',' ')} required.`);
        }
    }

    if (errorMessages.length > 0) {
        errorBox.innerHTML = `Error: ${errorMessages.join('<br>')}`;
        errorBox.style.display = 'block';
        return;
    }
    // --- End Validation ---

    // Calculate derived inputs
    inputs.bounding_width_m = Math.sqrt(area_sq_m / DroneMappingCalculator.ASPECT_RATIO);
    inputs.bounding_length_m = inputs.bounding_width_m * DroneMappingCalculator.ASPECT_RATIO;
    inputs.pixel_pitch_mm = inputs.sensor_pixels_width > 0 ? (inputs.sensor_width_mm / inputs.sensor_pixels_width) : 0;
     if (inputs.pixel_pitch_mm <= 0) {
          errorBox.innerText = `Error: Calculated pixel pitch is zero or negative. Check sensor width/pixels.`;
          errorBox.style.display = 'block';
          return;
     }

    // Calculate allowable duration range
    const min_allowable_duration = inputs.target_duration_min - input_duration_unc;
    const max_allowable_duration = inputs.target_duration_min + input_duration_unc;

    try {
        // Run calculation (includes feasibility check implicitly now)
        const r = DroneMappingCalculator.runTimeBasedCalculation(inputs);

        // --- Extract results ---
        const roundedHeight = r.roundedHeight;
        const roundedLineSpacing = r.roundedLineSpacing;
        const finalGSD = r.finalGSD;
        const footprint = r.footprint;
        const roundedSpeed = r.roundedSpeed; // Final, constrained, rounded speed
        const speed_color = r.speed_color;
        const speed_warning_text = r.speed_warning_text;
        const finalShutterInterval = r.finalShutterInterval;
        const finalAchievedFO = r.finalAchievedFO;
        const finalAchievedSO = r.finalAchievedSO;
        const finalNumLines = r.finalNumLines;
        const finalTotalPath = r.finalTotalPath;
        const finalDurationMin = r.finalDurationMin; // The key recalculated value

        // --- Warnings ---
        let warnings = [];
        if (roundedHeight > 120) {
            warnings.push(`Flight height (<span class="calculated-value">${roundedHeight.toFixed(1)} m</span>) may exceed typical limits.`);
        }
        // Check if final duration is within uncertainty range
        let duration_range_met = (finalDurationMin >= min_allowable_duration && finalDurationMin <= max_allowable_duration);
        let duration_color = duration_range_met ? 'green' : 'orange'; // Color for the result display
        let duration_warning_suffix = ''; // Text suffix for the result display
        if (!duration_range_met) {
            warnings.push(`Final duration (<span class="calculated-value">${finalDurationMin.toFixed(1)} min</span>) is outside target range [${min_allowable_duration.toFixed(1)} - ${max_allowable_duration.toFixed(1)}] due to constraints.`);
             duration_warning_suffix = ` (Target: ${inputs.target_duration_min.toFixed(1)} ± ${input_duration_unc.toFixed(1)})`;
        }
        // Display warnings if any
        if (warnings.length > 0) {
            errorBox.innerHTML = `Warning:<br>${warnings.join('<br>')}`;
            errorBox.style.display = 'block';
        }

        // --- DISPLAY FINAL RESULTS ---
        let fo_color = finalAchievedFO >= DroneMappingCalculator.MIN_FRONT_OVERLAP_FACTOR * 100 ? '#333' : 'red'; // Use constant for check
        let so_color = finalAchievedSO >= DroneMappingCalculator.MIN_SIDE_OVERLAP_FACTOR * 100 ? '#333' : 'red'; // Use constant for check
        // Combine speed warning with FO display
        let fo_warning = `(Achieved: ${finalAchievedFO.toFixed(1)}% / Target: ${inputs.front_overlap_factor * 100}%) ${speed_warning_text}`;
        let so_warning = `(Achieved: ${finalAchievedSO.toFixed(1)}% / Target: ${inputs.side_overlap_factor * 100}%)`;

        document.getElementById('res_gsd').innerText = finalGSD.toFixed(2);
        document.getElementById('res_height').innerText = roundedHeight.toFixed(1);
        document.getElementById('res_speed').innerHTML = `<strong style="color:${speed_color};">${roundedSpeed.toFixed(1)}</strong>`;
        document.getElementById('res_footprint_dims').innerText = `${footprint.height.toFixed(1)} x ${footprint.width.toFixed(1)}`;
        document.getElementById('res_footprint_area').innerText = footprint.area.toFixed(0);
        document.getElementById('res_length_width_display').innerText = `${inputs.bounding_length_m.toFixed(1)} x ${inputs.bounding_width_m.toFixed(1)}`;
        document.getElementById('res_calculated_area_display').innerText = area_sq_m.toFixed(0);
        document.getElementById('res_min_shutter').innerHTML = `<strong style="color:${fo_color};">${finalShutterInterval.toFixed(1)}</strong>`;
        document.getElementById('res_fo_detail').innerHTML = `<span style="color:${fo_color};">${fo_warning}</span>`;
        document.getElementById('res_line_spacing').innerText = roundedLineSpacing.toFixed(2);
        document.getElementById('res_so_detail').innerHTML = `<span style="color:${so_color};">${so_warning}</span>`;
        document.getElementById('res_path').innerText = (finalTotalPath / 1000).toFixed(2);
        document.getElementById('res_lines').innerText = finalNumLines;
        // Display final duration with color and optional warning suffix
        document.getElementById('res_duration').innerHTML = `<strong style="color:${duration_color};">${finalDurationMin.toFixed(1)}</strong><span style="font-size: 0.85em; color: ${duration_color};">${duration_warning_suffix}</span>`;

        publishMissionParameters('timeArea', {
            sourceLabel: 'Duration-based Planner',
            lineSpacingM: roundedLineSpacing,
            flightDirectionDeg: parseFloat(document.getElementById('flight_direction').value) || 0,
            heightM: roundedHeight,
            speedMps: roundedSpeed,
            gsdCm: finalGSD,
            footprintLengthM: footprint.height,
            footprintWidthM: footprint.width,
            footprintAreaSqM: footprint.area,
            targetAreaSqM: area_sq_m,
            boundingLengthM: inputs.bounding_length_m,
            boundingWidthM: inputs.bounding_width_m,
            pathLengthM: finalTotalPath,
            durationMin: finalDurationMin,
            lineCount: finalNumLines,
            shutterIntervalSec: finalShutterInterval,
            frontOverlapPercent: finalAchievedFO,
            sideOverlapPercent: finalAchievedSO
        });

        resultsBox.style.display = 'block'; // Show results

    } catch (e) {
        errorBox.innerText = `Calculation Error: ${e.message}. Adjust inputs.`;
        resultsBox.style.display = 'none';
        errorBox.style.display = 'block';
        console.error("Error in calculateMission:", e);
    }
}

/**
 * Main function for the GSD-based calculator.
 * Reads inputs, validates, performs smart rounding for height,
 * calls calculation logic, and displays results or errors/warnings.
 */
function calculateGSDMission() {
    const input_gsd_cm = parseFloat(document.getElementById('target_gsd').value);
    const input_gsd_unc = parseFloat(document.getElementById('target_gsd_unc').value) || 0; // Read uncertainty
    const input_area_ha = parseFloat(document.getElementById('gsd_area_hectares').value);
    const area_sq_m = input_area_ha * 10000;

    const errorBox = document.getElementById('gsdErrorMessage');
    const resultsBox = document.getElementById('gsdResults');
    errorBox.style.display = 'none'; // Clear previous
    resultsBox.style.display = 'none';
    setPlannerMapButton('gsd', false);

    // --- Input Gathering ---
    const inputs = {
        target_gsd_cm: input_gsd_cm,
        // target_gsd_unc: input_gsd_unc, // We use this locally for smart rounding
        flight_direction_deg: 0, // Fixed
        bounding_length_m: 0, // Will calculate
        bounding_width_m: 0, // Will calculate
        focal_length_mm: parseFloat(document.getElementById('gsd_focal_length').value),
        sensor_width_mm: parseFloat(document.getElementById('gsd_sensor_width').value),
        sensor_length_mm: parseFloat(document.getElementById('gsd_sensor_length').value),
        sensor_pixels_width: parseInt(document.getElementById('gsd_sensor_pixels_width').value, 10),
        max_speed_mps: parseFloat(document.getElementById('gsd_max_speed').value),
        min_speed_mps: parseFloat(document.getElementById('gsd_min_speed').value),
        min_shutter_interval_cap_sec: parseFloat(document.getElementById('gsd_min_shutter_interval').value),
        side_overlap_factor: parseFloat(document.getElementById('gsd_side_overlap').value) / 100,
        front_overlap_factor: parseFloat(document.getElementById('gsd_front_overlap').value) / 100
    };

    // --- Validation ---
     let errorMessages = [];
     if (isNaN(input_area_ha) || input_area_ha <= 0) errorMessages.push("Area must be positive.");
     if (isNaN(inputs.target_gsd_cm) || inputs.target_gsd_cm <= 0) errorMessages.push("Target GSD must be positive.");
     if (isNaN(input_gsd_unc) || input_gsd_unc < 0) errorMessages.push("GSD uncertainty must be non-negative.");
     if (input_gsd_unc >= inputs.target_gsd_cm) errorMessages.push("GSD uncertainty cannot be >= Target GSD.");
     if (inputs.min_speed_mps <= 0 || inputs.max_speed_mps <= 0 || inputs.min_speed_mps > inputs.max_speed_mps) errorMessages.push("Invalid speed limits (Min > 0, Min <= Max).");
     if (inputs.min_shutter_interval_cap_sec <=0) errorMessages.push("Shutter interval must be positive.");
     if (inputs.side_overlap_factor < 0 || inputs.side_overlap_factor >= 1) errorMessages.push("Side overlap must be between 0% and 100%.");
     if (inputs.front_overlap_factor < 0 || inputs.front_overlap_factor >= 1) errorMessages.push("Front overlap must be between 0% and 100%.");

     for (const key of ['focal_length_mm', 'sensor_width_mm', 'sensor_length_mm', 'sensor_pixels_width']) {
         if (isNaN(inputs[key]) || inputs[key] <= 0) {
             errorMessages.push(`Valid positive ${key.replace('_mm','').replace('_',' ')} required.`);
         }
     }
    if (errorMessages.length > 0) {
        errorBox.innerHTML = `Error: ${errorMessages.join('<br>')}`;
        errorBox.style.display = 'block';
        return;
    }
    // --- End Validation ---

    // Calculate derived inputs
    inputs.bounding_width_m = Math.sqrt(area_sq_m / DroneMappingCalculator.ASPECT_RATIO);
    inputs.bounding_length_m = inputs.bounding_width_m * DroneMappingCalculator.ASPECT_RATIO;
     inputs.pixel_pitch_mm = inputs.sensor_pixels_width > 0 ? (inputs.sensor_width_mm / inputs.sensor_pixels_width) : 0;
     if (inputs.pixel_pitch_mm <= 0) {
          errorBox.innerText = `Error: Calculated pixel pitch is zero or negative. Check sensor width/pixels.`;
          errorBox.style.display = 'block';
          return;
     }

    // Calculate allowable GSD range
    const min_allowable_gsd = inputs.target_gsd_cm - input_gsd_unc;
    const max_allowable_gsd = inputs.target_gsd_cm + input_gsd_unc;

    try {
        // --- Smart Height Rounding based on GSD Uncertainty ---
        const initial_height = DroneMappingCalculator.calculateHeight(inputs.target_gsd_cm, inputs.focal_length_mm, inputs.pixel_pitch_mm);

        let roundedHeight = -1; // Flag value to track if a suitable height was found
        let finalGSD = -1;
        let gsd_range_note = ""; // Note to display if range couldn't be met

        // Function to check if GSD for a height is within range
        const checkGSD = (h) => {
            if (h <= 0) return { valid: false, gsd: -1 }; // Height must be positive
            const gsd = DroneMappingCalculator.calculateGSD(h, inputs.focal_length_mm, inputs.pixel_pitch_mm);
            return { valid: (gsd >= min_allowable_gsd && gsd <= max_allowable_gsd), gsd: gsd };
        };

        // 1. Try normal rounding first
        let height_candidate = roundToHalf(initial_height);
        let check_result = checkGSD(height_candidate);
        if (check_result.valid) {
            roundedHeight = height_candidate;
            finalGSD = check_result.gsd;
        } else {
            // 2. If normal rounding failed, determine which way to try next based on GSD
            let height_up = Math.ceil(initial_height * 2) / 2; // Round up to nearest 0.5
            let height_down = Math.floor(initial_height * 2) / 2; // Round down to nearest 0.5

            // Prioritize closer adjustment if possible
             if (Math.abs(height_up - initial_height) <= Math.abs(height_down - initial_height)) {
                // Try Up first
                 check_result = checkGSD(height_up);
                 if (check_result.valid) {
                     roundedHeight = height_up;
                     finalGSD = check_result.gsd;
                 } else { // If Up fails, try Down
                     check_result = checkGSD(height_down);
                     if (check_result.valid) {
                         roundedHeight = height_down;
                         finalGSD = check_result.gsd;
                     }
                 }
            } else {
                 // Try Down first
                check_result = checkGSD(height_down);
                 if (check_result.valid) {
                     roundedHeight = height_down;
                     finalGSD = check_result.gsd;
                 } else { // If Down fails, try Up
                     check_result = checkGSD(height_up);
                     if (check_result.valid) {
                         roundedHeight = height_up;
                         finalGSD = check_result.gsd;
                     }
                 }
            }

            // 3. If BOTH adjustments failed, default back to normal rounding and add note
            if (roundedHeight === -1) {
                roundedHeight = roundToHalf(initial_height); // Default back
                finalGSD = DroneMappingCalculator.calculateGSD(roundedHeight, inputs.focal_length_mm, inputs.pixel_pitch_mm);
                gsd_range_note = ` (Note: Range ±${input_gsd_unc.toFixed(1)}cm not met due to rounding)`;
                // Display note in error box for visibility
                 errorBox.innerHTML = `Note: Final GSD (<span class="calculated-value">${finalGSD.toFixed(2)} cm/px</span>) is outside target range [${min_allowable_gsd.toFixed(1)} - ${max_allowable_gsd.toFixed(1)}] due to height rounding constraints.`;
                 errorBox.style.display = 'block';
            }
        }
        // --- End Smart Height Rounding ---

        // --- Proceed with calculations using the determined roundedHeight ---
        const footprint = DroneMappingCalculator.calculateFootprintDimensions(
            roundedHeight, inputs.focal_length_mm, inputs.sensor_width_mm, inputs.sensor_length_mm
        );
         if (footprint.width <= 0 || footprint.height <= 0) throw new Error("Calculated footprint dimensions must be positive.");
        const line_spacing_m = footprint.width * (1 - inputs.side_overlap_factor);
        const roundedLineSpacing = roundToQuarter(line_spacing_m);

        // Calculate required speed
        const photo_spacing_m = footprint.height * (1 - inputs.front_overlap_factor);
         if (inputs.min_shutter_interval_cap_sec <= 0) throw new Error("Shutter interval must be positive.");
        let finalSpeed = photo_spacing_m / inputs.min_shutter_interval_cap_sec;
        const finalShutterInterval = inputs.min_shutter_interval_cap_sec;

        // Constrain speed (using corrected logic)
        let speed_warning_text = '';
        let speed_color = '#333';
        if (finalSpeed < inputs.min_speed_mps) {
            finalSpeed = inputs.min_speed_mps;
            speed_warning_text = `WARNING: Capped at Min Speed (${finalSpeed.toFixed(1)} m/s). FO will be *lower*.`;
            speed_color = 'red';
        } else if (finalSpeed > inputs.max_speed_mps) {
            finalSpeed = inputs.max_speed_mps;
            speed_warning_text = `NOTE: Capped at Max Speed (${finalSpeed.toFixed(1)} m/s). FO will be *higher*.`;
            speed_color = 'orange';
        }
        const roundedSpeed = roundToHalf(finalSpeed);

        // Recalculate overlaps
        const finalAchievedFO = DroneMappingCalculator.calculateFrontOverlap(
            roundedSpeed, finalShutterInterval, roundedHeight, inputs.focal_length_mm, inputs.sensor_length_mm
        ) * 100;
        const finalAchievedSO = 100 * (1 - (roundedLineSpacing / footprint.width));

        // Recalculate Path and Duration
         if (roundedLineSpacing <= 0) throw new Error("Rounded line spacing must be positive.");
        const finalNumLinesRaw = inputs.bounding_width_m / roundedLineSpacing + 1;
        const finalNumLines = Math.ceil(finalNumLinesRaw);
        const finalTotalFlightTrack = finalNumLines * inputs.bounding_length_m;
        const finalTotalPath = finalTotalFlightTrack * DroneMappingCalculator.TURN_BUFFER_FACTOR;
        if (roundedSpeed <= 0) throw new Error("Rounded speed must be positive.");
        const finalDurationMin = (finalTotalPath / roundedSpeed) / 60;

        // --- Height Warning (check after smart rounding) ---
        if (roundedHeight > 120) {
             // Append warning if GSD note already exists
            if (errorBox.style.display === 'block') {
                 errorBox.innerHTML += '<br>';
            } else {
                 errorBox.innerHTML = ''; // Clear just in case
                 errorBox.style.display = 'block';
            }
            errorBox.innerHTML += `Warning: Suggested flight height (<span class="calculated-value">${roundedHeight.toFixed(1)} m</span>) may exceed limits. Consider increasing Target GSD.`;
        }


        // --- Display FINAL Results ---
        let fo_color = finalAchievedFO >= DroneMappingCalculator.MIN_FRONT_OVERLAP_FACTOR * 100 ? '#333' : 'red';
        let so_color = finalAchievedSO >= DroneMappingCalculator.MIN_SIDE_OVERLAP_FACTOR * 100 ? '#333' : 'red';
        let fo_warning = `(Achieved: ${finalAchievedFO.toFixed(1)}% / Target: ${inputs.front_overlap_factor * 100}%) ${speed_warning_text}`;
        let so_warning = `(Achieved: ${finalAchievedSO.toFixed(1)}% / Target: ${inputs.side_overlap_factor * 100}%)`;

        document.getElementById('gsd_res_duration').innerHTML = `<strong style="color:green;">${finalDurationMin.toFixed(1)}</strong>`;
        document.getElementById('gsd_res_speed').innerHTML = `<strong style="color:${speed_color};">${roundedSpeed.toFixed(1)}</strong>`;
        document.getElementById('gsd_res_speed_warning').innerText = ""; // Clear separate speed warning
        document.getElementById('gsd_res_height').innerText = roundedHeight.toFixed(1);
        document.getElementById('gsd_res_gsd').innerHTML = `${finalGSD.toFixed(2)}<span style="font-size: 0.85em; color: #6c757d;">${gsd_range_note}</span>`; // Display final GSD with note
        document.getElementById('gsd_res_footprint_dims').innerText = `${footprint.height.toFixed(1)} x ${footprint.width.toFixed(1)}`;
        document.getElementById('gsd_res_footprint_area').innerText = footprint.area.toFixed(0);
        document.getElementById('gsd_res_length_width_display').innerText = `${inputs.bounding_length_m.toFixed(1)} x ${inputs.bounding_width_m.toFixed(1)}`;
        document.getElementById('gsd_res_calculated_area_display').innerText = area_sq_m.toFixed(0);
        document.getElementById('gsd_res_path').innerText = (finalTotalPath / 1000).toFixed(2);
        document.getElementById('gsd_res_lines').innerText = finalNumLines;
        document.getElementById('gsd_res_line_spacing').innerText = roundedLineSpacing.toFixed(2);
        document.getElementById('gsd_res_so_detail').innerHTML = `<span style="color:${so_color};">${so_warning}</span>`;
        document.getElementById('gsd_res_min_shutter').innerHTML = `<strong style="color:${fo_color};">${finalShutterInterval.toFixed(1)}</strong>`;
        document.getElementById('gsd_res_fo_detail').innerHTML = `<span style="color:${fo_color};">${fo_warning}</span>`;

        publishMissionParameters('gsd', {
            sourceLabel: 'GSD-based Planner',
            lineSpacingM: roundedLineSpacing,
            flightDirectionDeg: inputs.flight_direction_deg || 0,
            heightM: roundedHeight,
            speedMps: roundedSpeed,
            gsdCm: finalGSD,
            footprintLengthM: footprint.height,
            footprintWidthM: footprint.width,
            footprintAreaSqM: footprint.area,
            targetAreaSqM: area_sq_m,
            boundingLengthM: inputs.bounding_length_m,
            boundingWidthM: inputs.bounding_width_m,
            pathLengthM: finalTotalPath,
            durationMin: finalDurationMin,
            lineCount: finalNumLines,
            shutterIntervalSec: finalShutterInterval,
            frontOverlapPercent: finalAchievedFO,
            sideOverlapPercent: finalAchievedSO
        });

        resultsBox.style.display = 'block'; // Show results

    } catch (e) {
        errorBox.innerText = `Calculation Error: ${e.message}. Check inputs.`;
        resultsBox.style.display = 'none';
        errorBox.style.display = 'block';
        console.error("Error in calculateGSDMission:", e);
    }
}

// --- Initial Setup ---
/**
 * Initializes the page on load: loads default drone specs and sets the initial view.
 */
document.addEventListener('DOMContentLoaded', function() {
    try {
        loadDroneSpecs(); // Load DJI Air 2S defaults
        switchCalculator('timeArea'); // Show Duration planner first
    } catch(e) {
        console.error("Error during page initialization:", e);
        // Optionally display an error to the user on the page itself
         const errorBox = document.getElementById('errorMessage') || document.getElementById('gsdErrorMessage');
         if(errorBox) {
            errorBox.innerText = "Initialization failed. Please refresh.";
            errorBox.style.display = 'block';
         }
    }
});
