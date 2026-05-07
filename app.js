// Holding policies for bus routes.

class BasePolicy {
    constructor() {
        // BasePolicy is an abstract class, but we allow instantiation for subclasses
    }

    /**
     * Compute policy holding time.
     * @param {Object} kwargs System state at the point a holding time needs to be computed.
     * @returns {number}
     */
    getHoldTime(kwargs = {}) {
        throw new Error('BasePolicy is an abstract class, getHoldTime must be implemented by subclasses!');
    }
}

class BolehPolicy extends BasePolicy {
    constructor() {
        super();
    }

    /**
     * Holding time is always 0.0, regardless of system state.
     * @returns {number}
     */
    getHoldTime(kwargs = {}) {
        return 0.0;
    }
}

class ScheduleDrivenPolicy extends BasePolicy {
    /**
     * @param {number[]|Object} scheduleOrOptions List of scheduled departure times or an options object.
     */
    constructor(scheduleOrOptions) {
        super();
        if (Array.isArray(scheduleOrOptions)) {
            this.schedule = scheduleOrOptions;
        } else {
            this.schedule = scheduleOrOptions?.schedule || [];
        }
        this.idx = 0;
    }

    /**
     * Hold a bus only if it arrives before the next scheduled departure.
     * @param {Object} kwargs
     * @param {number} kwargs.t The current time.
     * @returns {number}
     */
    getHoldTime(kwargs = {}) {
        const t = kwargs.t;
        const holdTime = Math.max(0.0, this.schedule[this.idx] - t);
        this.idx = (this.idx + 1) % this.schedule.length;
        return holdTime;
    }
}

class InfiniteSchedulePolicy extends BasePolicy {
    /**
     * @param {number|Object} timeDeltaOrOptions Time between scheduled releases, or options object.
     * @param {number} [offset] Schedule phase.
     */
    constructor(timeDeltaOrOptions, offset) {
        super();
        if (typeof timeDeltaOrOptions === 'object' && timeDeltaOrOptions !== null) {
            this.timeDelta = timeDeltaOrOptions.time_delta ?? timeDeltaOrOptions.timeDelta;
            this.nextRelease = timeDeltaOrOptions.offset ?? 0;
        } else {
            this.timeDelta = timeDeltaOrOptions;
            this.nextRelease = offset;
        }
    }

    /**
     * Hold a bus only if it arrives before the next scheduled departure.
     * @param {Object} kwargs
     * @param {number} kwargs.t The current time.
     * @returns {number}
     */
    getHoldTime(kwargs = {}) {
        const t = kwargs.t;
        const holdTime = Math.max(0.0, this.nextRelease - t);
        this.nextRelease += this.timeDelta;
        return holdTime;
    }
}

class HeadwayDrivenPolicy extends BasePolicy {
    /**
     * @param {number|Object} activationRatioOrOptions Activation ratio or options object.
     * @param {number} [maxHolding] Do not hold vehicles longer than this interval.
     */
    constructor(activationRatioOrOptions, maxHolding) {
        super();
        if (typeof activationRatioOrOptions === 'object' && activationRatioOrOptions !== null) {
            this.activationRatio = activationRatioOrOptions.activation_ratio ?? activationRatioOrOptions.activationRatio;
            this.maxHolding = activationRatioOrOptions.max_holding ?? activationRatioOrOptions.maxHolding;
        } else {
            this.activationRatio = activationRatioOrOptions;
            this.maxHolding = maxHolding;
        }
    }

    /**
     * Hold a bus until headway == tailway.
     * @param {Object} kwargs
     * @param {number} kwargs.t The current time.
     * @param {number|null} kwargs.d_leader The departure time of the lead vehicle.
     * @param {number|null} kwargs.a_follower The estimated arrival time of the following vehicle.
     * @returns {number}
     */
    getHoldTime(kwargs = {}) {
        const dLeader = kwargs.d_leader;
        const aFollower = kwargs.a_follower;
        const aSelf = kwargs.t;
        if (dLeader == null || aFollower == null) {
            return 0.0;
        }
        const headway = aSelf - dLeader;
        const tailway = aFollower - aSelf;
        if (tailway === 0) {
            return 0.0;
        }
        if (headway / tailway < this.activationRatio) {
            return Math.min(Math.max(0, (aFollower + dLeader - 2 * aSelf) / 2), this.maxHolding);
        }
        return 0.0;
    }
}

class Stop {
    /**
     * @param {[number, number]} tau Tuple containing the minimum and maximum travel time to the next stop.
     * @param {[number, number]} delta Tuple containing the minimum and maximum dwell time at this stop.
     * @param {BasePolicy} policy The holding policy governing this stop.
     */
    constructor(tau, delta, policy) {
        this.tau = tau;
        this.delta = delta;
        this.policy = policy;
    }
}

class StopConfig {
    /**
     * @param {[number, number]} tau
     * @param {[number, number]} delta
     * @param {typeof BasePolicy} policy
     * @param {Object} policyArgs
     */
    constructor(tau, delta, policy, policyArgs) {
        this.tau = tau;
        this.delta = delta;
        this.policy = policy;
        this.policyArgs = policyArgs;
    }
}

/**
 * Create a new instance of a route from a template.
 * @param {StopConfig[]} config List of configurations for each stop in the route.
 * @returns {Stop[]}
 */
function routeFactory(config) {
    const route = [];
    for (const stopConfig of config) {
        route.push(new Stop(
            stopConfig.tau,
            stopConfig.delta,
            new stopConfig.policy(stopConfig.policyArgs || {})
        ));
    }
    return route;
}

/**
 * Calculate upper and lower headway bounds for each stop along a route.
 * @param {Stop[]} route
 * @param {number[]} startTimes The list of start times at stop 0 for all vehicles serving the route.
 * @param {number} tMax Optional cutoff time for routes that terminate service within a given interval.
 * @returns {[number[], number[]]}
 */
function headwayBounds(route, startTimes, tMax = Infinity) {
    const M = startTimes.length;
    const N = route.length;
    let i = 0;
    let stop = route[i];
    const htub = Array(N).fill(-Infinity);
    const htlb = Array(N).fill(Infinity);
    const carryIn = Array(N).fill(null);
    const arrivals = Array.from({ length: N }, () => []);
    const departures = Array.from({ length: N }, () => []);
    departures[0] = [...startTimes];
    let converged = false;

    while (!converged && departures[i][departures[i].length - 1] < tMax) {
        const iPrev = i;
        i = (i + 1) % N;
        const stopPrev = stop;
        stop = route[i];

        console.log(htub);

        arrivals[i] = [];
        arrivals[i].push(departures[iPrev][0] + Math.max(...stopPrev.tau));
        for (let j = 1; j < M; j += 1) {
            const lower = Math.min(...stopPrev.tau);
            const upper = Math.max(...stopPrev.tau);
            const tau = Math.min(Math.max(lower, arrivals[i][j - 1] - departures[iPrev][j]), upper);
            arrivals[i].push(departures[iPrev][j] + tau);
        }

        departures[i] = [];
        let aFollower = null;
        if (M > 1) {
            aFollower = departures[iPrev][1] + Math.max(...stopPrev.tau);
        } else {
            aFollower = departures[iPrev][0] + route.reduce((sum, stopItem) => sum + Math.max(...stopItem.tau) + Math.max(...stopItem.delta), 0);
        }

        let policyArgs = {
            t: arrivals[i][0],
            d_leader: carryIn[i],
            a_follower: aFollower,
        };
        departures[i].push(arrivals[i][0] + Math.max(Math.max(...stop.delta), stop.policy.getHoldTime(policyArgs)));

        for (let j = 1; j < M; j += 1) {
            if (j + 1 < M) {
                aFollower = departures[iPrev][j + 1] + Math.min(...stopPrev.tau);
            } else {
                aFollower = departures[i][0] + route.reduce((sum, stopItem) => sum + Math.min(...stopItem.tau) + Math.min(...stopItem.delta), 0);
            }
            policyArgs = {
                t: arrivals[i][j],
                d_leader: departures[i][j - 1],
                a_follower: aFollower,
            };
            const lowerDelta = Math.min(...stop.delta);
            const upperDelta = Math.max(...stop.delta);
            const delta = Math.min(Math.max(lowerDelta, departures[i][j - 1] - arrivals[i][j]), upperDelta);
            departures[i].push(arrivals[i][j] + Math.max(delta, stop.policy.getHoldTime(policyArgs)));
        }

        if (carryIn[i] != null) {
            const headway = Math.max(0, arrivals[i][0] - carryIn[i]);
            if (headway > htub[i]) {
                htub[i] = headway;
            } else {
                converged = true;
            }
        }

        const lowHeadway = Math.max(0, arrivals[i][1] - departures[i][0]);
        if (lowHeadway < htlb[i]) {
            htlb[i] = lowHeadway;
            converged = false;
        }

        carryIn[i] = departures[i][departures[i].length - 1];
    }

    return [htub, htlb];
}

class GTFSAnalyzer {
    constructor() {
        this.routes = [];
        this.stops = {};
        this.stopTimes = [];
        this.trips = {};
        this.selectedRoute = null;
        this.stopConfigs = {};
        this.chart = null;
    }

    // Parse CSV data manually (simple parser)
    parseCSV(text) {
        const lines = text.trim().split('\n');
        const headers = lines[0].split(',').map(h => h.trim());
        const data = [];
        
        for (let i = 1; i < lines.length; i++) {
            const line = lines[i];
            if (!line.trim()) continue;
            
            const values = this.parseCSVLine(line);
            const row = {};
            
            for (let j = 0; j < headers.length; j++) {
                row[headers[j]] = values[j] || '';
            }
            
            data.push(row);
        }
        
        return data;
    }

    // Helper to parse a single CSV line (handles quoted fields)
    parseCSVLine(line) {
        const result = [];
        let current = '';
        let inQuotes = false;
        
        for (let i = 0; i < line.length; i++) {
            const char = line[i];
            
            if (char === '"') {
                inQuotes = !inQuotes;
            } else if (char === ',' && !inQuotes) {
                result.push(current.trim());
                current = '';
            } else {
                current += char;
            }
        }
        
        result.push(current.trim());
        return result;
    }

    // Convert time string HH:MM:SS to minutes since midnight
    timeToMinutes(timeStr) {
        const [hours, minutes, seconds] = timeStr.split(':').map(Number);
        return hours * 60 + minutes;
    }

    // Format minutes since midnight back to HH:MM:SS
    minutesToTime(minutes) {
        const hours = Math.floor(minutes / 60);
        const mins = minutes % 60;
        return `${String(hours).padStart(2, '0')}:${String(mins).padStart(2, '0')}`;
    }

    // Load and process GTFS zip file
    async loadGTFSFile(file) {
        try {
            const zip = await JSZip.loadAsync(file);
            
            // Load required files
            const routesFile = zip.file('routes.txt');
            const stopsFile = zip.file('stops.txt');
            const stopTimesFile = zip.file('stop_times.txt');
            const tripsFile = zip.file('trips.txt');
            
            if (!routesFile || !stopsFile || !stopTimesFile || !tripsFile) {
                throw new Error('Required GTFS files missing (routes.txt, stops.txt, stop_times.txt, trips.txt)');
            }
            
            // Extract and parse files
            const routesText = await routesFile.async('text');
            const stopsText = await stopsFile.async('text');
            const stopTimesText = await stopTimesFile.async('text');
            const tripsText = await tripsFile.async('text');
            
            this.routes = this.parseCSV(routesText);
            const stopsArray = this.parseCSV(stopsText);
            this.stopTimes = this.parseCSV(stopTimesText);
            const tripsArray = this.parseCSV(tripsText);
            
            // Index stops and trips for quick lookup
            stopsArray.forEach(stop => {
                this.stops[stop.stop_id] = stop;
            });
            
            tripsArray.forEach(trip => {
                this.trips[trip.trip_id] = trip;
            });
            
            return true;
        } catch (error) {
            console.error('Error loading GTFS file:', error);
            throw error;
        }
    }

    // Get route display name
    getRouteName(route) {
        return route.route_short_name || route.route_long_name || route.route_id;
    }

    // Get stops for a selected route, ordered by earliest departure
    getStopsForRoute(routeId) {
        // Find all trips for this route
        const routeTrips = Object.values(this.trips).filter(trip => trip.route_id === routeId);
        
        if (routeTrips.length === 0) return {};
        
        // Group trips by direction
        const directions = {};
        routeTrips.forEach(trip => {
            const dirId = trip.direction_id || '0';
            if (!directions[dirId]) {
                directions[dirId] = [];
            }
            directions[dirId].push(trip);
        });
        
        // For each direction, find stops in order
        const result = {};
        Object.keys(directions).forEach(dirId => {
            const dirTrips = directions[dirId];
            
            // Find the trip with earliest departure
            let earliestTrip = dirTrips[0];
            let earliestTime = Infinity;
            
            dirTrips.forEach(trip => {
                const tripStopTimes = this.stopTimes.filter(st => st.trip_id === trip.trip_id);
                if (tripStopTimes.length > 0) {
                    const firstDeparture = this.timeToMinutes(tripStopTimes[0].departure_time);
                    if (firstDeparture < earliestTime) {
                        earliestTime = firstDeparture;
                        earliestTrip = trip;
                    }
                }
            });
            
            // Get stops for earliest trip, in order
            const tripStopTimes = this.stopTimes
                .filter(st => st.trip_id === earliestTrip.trip_id)
                .sort((a, b) => Number(a.stop_sequence) - Number(b.stop_sequence));
            
            result[dirId] = tripStopTimes.map(st => ({
                stopId: st.stop_id,
                stopName: this.stops[st.stop_id]?.stop_name || st.stop_id,
                sequence: Number(st.stop_sequence)
            }));
        });
        
        return result;
    }

    // Calculate headways for a stop
    calculateHeadways(routeId, stopId, filters = {}) {
        const { minTravelTime = 0, maxTravelTime = 60, minDwellTime = 0, maxDwellTime = 60, policies = [] } = filters;
        
        // Get all trips for this route
        const routeTrips = Object.values(this.trips).filter(trip => trip.route_id === routeId);
        
        // Get all stop times for this stop across all trips
        const stopTimesForStop = this.stopTimes
            .filter(st => st.stop_id === stopId && routeTrips.some(t => t.trip_id === st.trip_id))
            .map(st => {
                const trip = this.trips[st.trip_id];
                return {
                    tripId: st.trip_id,
                    directionId: trip.direction_id || '0',
                    arrivalTime: this.timeToMinutes(st.arrival_time),
                    departureTime: this.timeToMinutes(st.departure_time),
                    stopSequence: Number(st.stop_sequence)
                };
            })
            .sort((a, b) => a.arrivalTime - b.arrivalTime);
        
        // Calculate headways (time between consecutive buses)
        const headways = [];
        for (let i = 1; i < stopTimesForStop.length; i++) {
            const headway = stopTimesForStop[i].arrivalTime - stopTimesForStop[i-1].arrivalTime;
            headways.push(headway);
        }
        
        if (headways.length === 0) {
            return { max: 0, min: 0, average: 0, count: 0 };
        }
        
        return {
            max: Math.max(...headways),
            min: Math.min(...headways),
            average: headways.reduce((a, b) => a + b, 0) / headways.length,
            count: headways.length
        };
    }
}

// Initialize analyzer
const analyzer = new GTFSAnalyzer();

// DOM Elements
const gtfsFileInput = document.getElementById('gtfs-file');
const uploadStatus = document.getElementById('upload-status');
const routeSection = document.getElementById('route-section');
const routeSelect = document.getElementById('route-select');
const stopsSection = document.getElementById('stops-section');
const stopsContainer = document.getElementById('stops-container');
const analyzeSection = document.getElementById('analyze-section');
const analyzeBtn = document.getElementById('analyze-btn');
const resultsSection = document.getElementById('results-section');
const headwayChart = document.getElementById('headway-chart');

let activeDualRange = null;

// Event Listeners
gtfsFileInput.addEventListener('change', handleFileUpload);
routeSelect.addEventListener('change', handleRouteSelection);
analyzeBtn.addEventListener('click', handleAnalyze);

// Show status message
function showStatus(message, type = 'info') {
    uploadStatus.textContent = message;
    uploadStatus.className = `status-message show ${type}`;
    if (type === 'success') {
        setTimeout(() => uploadStatus.classList.remove('show'), 4000);
    }
}

// Handle GTFS file upload
async function handleFileUpload(event) {
    const file = event.target.files[0];
    if (!file) return;
    
    try {
        showStatus('Processing GTFS file...', 'info');
        
        await analyzer.loadGTFSFile(file);
        
        // Populate route dropdown
        routeSelect.innerHTML = '<option value="">-- Choose a route --</option>';
        analyzer.routes.forEach(route => {
            const option = document.createElement('option');
            option.value = route.route_id;
            option.textContent = analyzer.getRouteName(route);
            routeSelect.appendChild(option);
        });
        
        routeSection.style.display = 'block';
        stopsSection.style.display = 'none';
        analyzeSection.style.display = 'none';
        resultsSection.style.display = 'none';
        
        showStatus(`GTFS file loaded! Found ${analyzer.routes.length} routes.`, 'success');
    } catch (error) {
        showStatus(`Error: ${error.message}`, 'error');
        routeSection.style.display = 'none';
    }
}

// Handle route selection
function handleRouteSelection(event) {
    const routeId = event.target.value;
    if (!routeId) {
        stopsSection.style.display = 'none';
        analyzeSection.style.display = 'none';
        return;
    }
    
    analyzer.selectedRoute = routeId;
    const stopsMap = analyzer.getStopsForRoute(routeId);
    
    // Combine stops from all directions
    const allStops = [];
    const stopIds = new Set();
    
    Object.keys(stopsMap).forEach(dirId => {
        stopsMap[dirId].forEach(stop => {
            if (!stopIds.has(stop.stopId)) {
                allStops.push(stop);
                stopIds.add(stop.stopId);
            }
        });
    });
    
    if (allStops.length === 0) {
        showStatus('No stops found for this route', 'error');
        stopsSection.style.display = 'none';
        return;
    }
    
    // Display stops
    displayStops(allStops);
    stopsSection.style.display = 'block';
    analyzeSection.style.display = 'block';
    resultsSection.style.display = 'none';
}

// Display stops with controls
function displayStops(stops) {
    stopsContainer.innerHTML = '';
    analyzer.stopConfigs = {};
    
    stops.forEach((stop, index) => {
        const stopCard = document.createElement('div');
        stopCard.className = 'stop-card';
        
        const stopId = stop.stopId;
        analyzer.stopConfigs[stopId] = {
            minTravelTime: 1,
            maxTravelTime: 5,
            minDwellTime: 0,
            maxDwellTime: 5,
            minHoldingTime: 0,
            maxHoldingTime: 10,
            holdingPolicies: ['None']
        };
        
        stopCard.innerHTML = `
            <div class="stop-header">${index + 1}. ${stop.stopName}</div>
            
            <div class="stop-control-group">
                <div class="control-label">Travel Time Range</div>
                <div class="slider-values" id="travel-values-${stopId}">1 - 5 min</div>
                <div class="range-slider">
                    <input
                        type="range"
                        min="1"
                        max="5"
                        step="0.5"
                        value="1"
                        class="dual-range-input"
                        data-stop="${stopId}"
                        data-type="travel"
                        data-handle="low"
                    >
                    <input
                        type="range"
                        min="1"
                        max="5"
                        step="0.5"
                        value="5"
                        class="dual-range-input"
                        data-stop="${stopId}"
                        data-type="travel"
                        data-handle="high"
                    >
                </div>
            </div>
            
            <div class="stop-control-group">
                <div class="control-label">Dwell Time Range</div>
                <div class="slider-values" id="dwell-values-${stopId}">0 - 5 min</div>
                <div class="range-slider">
                    <input
                        type="range"
                        min="0"
                        max="5"
                        step="0.5"
                        value="0"
                        class="dual-range-input"
                        data-stop="${stopId}"
                        data-type="dwell"
                        data-handle="low"
                    >
                    <input
                        type="range"
                        min="0"
                        max="5"
                        step="0.5"
                        value="5"
                        class="dual-range-input"
                        data-stop="${stopId}"
                        data-type="dwell"
                        data-handle="high"
                    >
                </div>
            </div>
            
            <div class="holding-policy-group">
                <label class="policy-label">Holding Policy</label>
                <div class="policy-options">
                    <div class="policy-checkbox">
                        <input 
                            type="checkbox" 
                            id="policy-none-${stopId}" 
                            value="None"
                            class="holding-policy-checkbox"
                            data-stop="${stopId}"
                            checked
                        >
                        <label for="policy-none-${stopId}">None</label>
                    </div>
                    <div class="policy-checkbox">
                        <input 
                            type="checkbox" 
                            id="policy-scheduled-${stopId}" 
                            value="Scheduled"
                            class="holding-policy-checkbox"
                            data-stop="${stopId}"
                        >
                        <label for="policy-scheduled-${stopId}">Scheduled</label>
                    </div>
                    <div class="policy-checkbox">
                        <input 
                            type="checkbox" 
                            id="policy-dynamic-${stopId}" 
                            value="Dynamic"
                            class="holding-policy-checkbox"
                            data-stop="${stopId}"
                        >
                        <label for="policy-dynamic-${stopId}">Dynamic</label>
                    </div>
                </div>
                <div class="dynamic-holding-slider" id="dynamic-holding-${stopId}" style="display: none;">
                    <div class="control-label">Holding Time Range</div>
                    <div class="slider-values" id="holding-values-${stopId}">0 - 10 min</div>
                    <div class="range-slider">
                        <input
                            type="range"
                            min="0"
                            max="10"
                            value="0"
                            class="dual-range-input"
                            data-stop="${stopId}"
                            data-type="holding"
                            data-handle="low"
                        >
                        <input
                            type="range"
                            min="0"
                            max="10"
                            value="10"
                            class="dual-range-input"
                            data-stop="${stopId}"
                            data-type="holding"
                            data-handle="high"
                        >
                    </div>
                </div>
            </div>
        `;
        
        stopsContainer.appendChild(stopCard);
    });
    
    // Attach event listeners to range wrappers
    document.querySelectorAll('.range-slider').forEach(sliderWrapper => {
        sliderWrapper.addEventListener('pointerdown', handleDualRangePointerDown);
    });
    
    document.querySelectorAll('.holding-policy-checkbox').forEach(checkbox => {
        checkbox.addEventListener('change', handlePolicyChange);
    });
}

// Handle dual-handle slider wrapper pointer down
function handleDualRangePointerDown(event) {
    const wrapper = event.currentTarget;
    const lowInput = wrapper.querySelector('input[data-handle="low"]');
    const highInput = wrapper.querySelector('input[data-handle="high"]');

    if (!lowInput || !highInput) return;

    const stopId = lowInput.dataset.stop;
    const sliderType = lowInput.dataset.type;
    const rect = wrapper.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const maxValue = Number(lowInput.max);
    const width = rect.width;

    const lowValue = Number(lowInput.value);
    const highValue = Number(highInput.value);
    const lowPosition = (lowValue / maxValue) * width;
    const highPosition = (highValue / maxValue) * width;
    const distanceToLow = Math.abs(x - lowPosition);
    const distanceToHigh = Math.abs(x - highPosition);
    const handle = distanceToLow <= distanceToHigh ? 'low' : 'high';

    activeDualRange = {
        wrapper,
        lowInput,
        highInput,
        stopId,
        sliderType,
        handle,
        maxValue
    };

    document.addEventListener('pointermove', handleDualRangePointerMove);
    document.addEventListener('pointerup', handleDualRangePointerUp);
    document.addEventListener('pointercancel', handleDualRangePointerUp);

    setDualRangeValueFromPointer(event.clientX);
    event.preventDefault();
}

function handleDualRangePointerMove(event) {
    if (!activeDualRange) return;
    setDualRangeValueFromPointer(event.clientX);
}

function handleDualRangePointerUp() {
    if (!activeDualRange) return;
    document.removeEventListener('pointermove', handleDualRangePointerMove);
    document.removeEventListener('pointerup', handleDualRangePointerUp);
    document.removeEventListener('pointercancel', handleDualRangePointerUp);
    activeDualRange = null;
}

function setDualRangeValueFromPointer(clientX) {
    const { wrapper, lowInput, highInput, handle, maxValue, sliderType, stopId } = activeDualRange;
    const rect = wrapper.getBoundingClientRect();
    let x = clientX - rect.left;
    x = Math.max(0, Math.min(rect.width, x));
    let value = (x / rect.width) * maxValue;
    
    // Round to nearest 0.5 for travel and dwell time, otherwise round to nearest integer
    if (sliderType === 'travel' || sliderType === 'dwell') {
        value = Math.round(value * 2) / 2;
    } else {
        value = Math.round(value);
    }

    if (handle === 'low') {
        lowInput.value = Math.min(value, Number(highInput.value));
    } else {
        highInput.value = Math.max(value, Number(lowInput.value));
    }

    handleDualRangeInput({ target: handle === 'low' ? lowInput : highInput });
}

// Handle dual-handle range input for travel and dwell
function handleDualRangeInput(event) {
    const stopId = event.target.dataset.stop;
    const sliderType = event.target.dataset.type; // travel or dwell
    const handle = event.target.dataset.handle; // low or high
    const lowInput = document.querySelector(`input[data-stop="${stopId}"][data-type="${sliderType}"][data-handle="low"]`);
    const highInput = document.querySelector(`input[data-stop="${stopId}"][data-type="${sliderType}"][data-handle="high"]`);

    let lowValue = Number(lowInput.value);
    let highValue = Number(highInput.value);

    if (lowValue > highValue) {
        if (handle === 'low') {
            lowValue = highValue;
            lowInput.value = lowValue;
        } else {
            highValue = lowValue;
            highInput.value = highValue;
        }
    }

    const minValue = Math.min(lowValue, highValue);
    const maxValue = Math.max(lowValue, highValue);
    const configKeyMin = `min${sliderType[0].toUpperCase() + sliderType.slice(1)}Time`;
    const configKeyMax = `max${sliderType[0].toUpperCase() + sliderType.slice(1)}Time`;
    analyzer.stopConfigs[stopId][configKeyMin] = minValue;
    analyzer.stopConfigs[stopId][configKeyMax] = maxValue;

    const displayId = `${sliderType}-values-${stopId}`;
    const display = document.getElementById(displayId);
    if (display) {
        display.textContent = `${minValue} - ${maxValue} min`;
    }
}

// Handle holding policy checkbox change
function handlePolicyChange(event) {
    const stopId = event.target.dataset.stop;
    const policy = event.target.value;
    const isChecked = event.target.checked;
    const wrapper = event.target.closest('.policy-options');
    const policies = analyzer.stopConfigs[stopId].holdingPolicies;
    const dynamicSlider = wrapper.parentElement.querySelector(`#dynamic-holding-${stopId}`);

    if (isChecked) {
        policies.length = 0;
        policies.push(policy);
        wrapper.querySelectorAll('.holding-policy-checkbox').forEach(cb => {
            cb.checked = cb.value === policy;
        });
        if (policy === 'Dynamic') {
            dynamicSlider.style.display = 'block';
        } else {
            dynamicSlider.style.display = 'none';
        }
    } else {
        // Prevent deselecting all options; keep the current option selected
        event.target.checked = true;
    }
}

// Handle analyze button click
function handleAnalyze() {
    if (!analyzer.selectedRoute) {
        showStatus('Please select a route', 'error');
        return;
    }
    
    // Get all stops from the configuration
    const stopIds = Object.keys(analyzer.stopConfigs);
    
    if (stopIds.length === 0) {
        showStatus('No stops available', 'error');
        return;
    }
    
    // Build stop list for analysis
    const stopList = stopIds.map(stopId => {
        const config = analyzer.stopConfigs[stopId];
        const stopName = analyzer.stops[stopId]?.stop_name || stopId;
        const holdingPolicy = config.holdingPolicies[0] || 'None';
        let policyClass;
        let policyArgs = {};
        
        if (holdingPolicy === 'None') {
            policyClass = BolehPolicy;
            console.log(`Stop ${stopId}: Using BolehPolicy (no holding)`);
        } else if (holdingPolicy === 'Scheduled') {
            policyClass = ScheduleDrivenPolicy;
            // Use a regular schedule with 10-minute intervals starting from time 0
            policyArgs = [0, 600, 1200, 1800, 2400]; // 0, 10min, 20min, 30min, 40min in seconds
            console.log(`Stop ${stopId}: Using ScheduleDrivenPolicy with schedule ${policyArgs}`);
        } else if (holdingPolicy === 'Dynamic') {
            policyClass = HeadwayDrivenPolicy;
            policyArgs = { activationRatio: 1.0, maxHolding: config.maxHoldingTime };
            console.log(`Stop ${stopId}: Using HeadwayDrivenPolicy with activationRatio=${policyArgs.activationRatio}, maxHolding=${policyArgs.maxHolding}`);
        } else {
            // Default to no holding if policy is unrecognized
            policyClass = BolehPolicy;
            console.log(`Stop ${stopId}: Unknown policy '${holdingPolicy}', defaulting to BolehPolicy`);
        }
        
        return {
            stopId,
            stopName,
            tau: [config.minTravelTime, config.maxTravelTime],
            delta: [config.minDwellTime, config.maxDwellTime],
            policy: policyClass,
            policyName: holdingPolicy,
            policyArgs
        };
    });

    
    // Create route and calculate headway bounds
    const route = routeFactory(stopList);
    console.log('Route created with', route.length, 'stops');
    
    // Get typical headway from GTFS data or use default
    let startTimes = [0, 600]; // Default fallback
    try {
        // Find all blocks (sequences of trips) for this route
        const routeTrips = Object.values(analyzer.trips).filter(trip => trip.route_id === analyzer.selectedRoute);
        
        if (routeTrips.length > 0) {
            // Group trips by block_id
            const blocks = {};
            routeTrips.forEach(trip => {
                const blockId = trip.block_id;
                if (blockId) {
                    if (!blocks[blockId]) {
                        blocks[blockId] = [];
                    }
                    blocks[blockId].push(trip);
                }
            });
            
            if (Object.keys(blocks).length > 0) {
                // For each block, find the earliest departure time
                const blockStartTimes = [];
                Object.values(blocks).forEach(blockTrips => {
                    // Find the earliest departure across all trips in this block
                    let earliestDeparture = Infinity;
                    blockTrips.forEach(trip => {
                        const tripStopTimes = analyzer.stopTimes.filter(st => st.trip_id === trip.trip_id);
                        if (tripStopTimes.length > 0) {
                            // Find the first stop's departure time
                            const firstStop = tripStopTimes.reduce((earliest, current) => {
                                const currentSeq = Number(current.stop_sequence);
                                const earliestSeq = Number(earliest.stop_sequence);
                                return currentSeq < earliestSeq ? current : earliest;
                            });
                            const departureTime = analyzer.timeToMinutes(firstStop.departure_time);
                            if (departureTime < earliestDeparture) {
                                earliestDeparture = departureTime;
                            }
                        }
                    });
                    
                    if (earliestDeparture < Infinity) {
                        // Convert to seconds since midnight
                        blockStartTimes.push(earliestDeparture * 60);
                    }
                });
                
                // Sort the block start times and truncate if a gap exceeds 60 minutes
                blockStartTimes.sort((a, b) => a - b);
                const maxGapSeconds = 60 * 60;
                const truncatedBlockStartTimes = [];
                for (let idx = 0; idx < blockStartTimes.length; idx += 1) {
                    if (idx === 0) {
                        truncatedBlockStartTimes.push(blockStartTimes[idx]);
                        continue;
                    }
                    const gap = blockStartTimes[idx] - blockStartTimes[idx - 1];
                    if (gap > maxGapSeconds) {
                        console.log(`Gap of ${gap / 60} minutes found between start times ${blockStartTimes[idx - 1]} and ${blockStartTimes[idx]}; truncating the list.`);
                        break;
                    }
                    truncatedBlockStartTimes.push(blockStartTimes[idx]);
                }
                blockStartTimes.length = 0;
                blockStartTimes.push(...truncatedBlockStartTimes);

                if (blockStartTimes.length >= 2) {
                    // Use all block start times up to the truncation point
                    startTimes = blockStartTimes;
                    console.log(`Using ${blockStartTimes.length} block start times after truncation: [${blockStartTimes.join(', ')}] seconds`);
                } else if (blockStartTimes.length === 1) {
                    // Only one block, use it and add a default second vehicle
                    const headway = 600; // 10 minutes
                    startTimes = [blockStartTimes[0], blockStartTimes[0] + headway];
                    console.log(`Only one block found, using [${blockStartTimes[0]}, ${blockStartTimes[0] + headway}] seconds`);
                } else {
                    console.log('No block start times found, using default');
                }
            } else {
                console.log('No blocks found, using default start times');
            }
        }
    } catch (error) {
        console.log('Could not calculate start times from GTFS blocks, using default:', error.message);
    }
    
    console.log(`Final start times: [${startTimes[0]}, ${startTimes[1]}] seconds (${(startTimes[1] - startTimes[0]) / 60} minutes headway)`);
    
    // Normalize startTimes so the earliest vehicle starts at time 0
    if (startTimes.length > 0) {
        const earliestStart = Math.min(...startTimes);
        startTimes = startTimes.map(time => (time - earliestStart) / 60); // Convert to minutes
        console.log(`Normalized start times: [${startTimes.join(', ')}] minutes (relative to first vehicle at t=0)`);
    }
    
    console.log('Routes:', route);

    const [htub, htlb] = headwayBounds(route, startTimes);
    console.log('Headway bounds calculated:', { htub, htlb });
    
    // Convert to minutes and prepare data for chart
    const headwayData = stopList.map((stop, index) => {
        let maxHeadway = htub[index];
        let minHeadway = htlb[index];
        
        // Handle invalid bounds
        if (!isFinite(maxHeadway) || maxHeadway < 0) maxHeadway = 0;
        if (!isFinite(minHeadway) || minHeadway < 0) minHeadway = 0;
        
        return {
            stopName: stop.stopName,
            maxHeadway: maxHeadway,
            minHeadway: minHeadway
        };
    });
    
    // Display results
    displayHeadwayChart(headwayData);
    resultsSection.style.display = 'block';
    
    // Scroll to results
    resultsSection.scrollIntoView({ behavior: 'smooth' });
}

// Display headway chart
function displayHeadwayChart(headwayData) {
    const ctx = headwayChart.getContext('2d');
    
    // Destroy existing chart if it exists
    if (analyzer.chart) {
        analyzer.chart.destroy();
    }
    
    const labels = headwayData.map(d => d.stopName);
    const maxData = headwayData.map(d => d.maxHeadway);
    const minData = headwayData.map(d => d.minHeadway);
    
    // Find the maximum value for scaling
    const maxValue = Math.max(...maxData);
    
    analyzer.chart = new Chart(ctx, {
        type: 'bar',
        data: {
            labels: labels,
            datasets: [
                {
                    label: 'Headway Range (min)',
                    data: maxData,
                    base: minData, // Start each bar at the lower bound
                    backgroundColor: 'rgba(54, 162, 235, 0.7)',
                    borderColor: 'rgba(54, 162, 235, 1)',
                    borderWidth: 1,
                    borderSkipped: false
                }
            ]
        },
        options: {
            indexAxis: 'y',
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: {
                    display: false // Hide legend since we only have one dataset
                },
                title: {
                    display: true,
                    text: 'Headway Times by Stop'
                },
                tooltip: {
                    callbacks: {
                        label: function(context) {
                            const minVal = minData[context.dataIndex];
                            const maxVal = maxData[context.dataIndex];
                            return `Headway Range: ${minVal} - ${maxVal} min`;
                        }
                    }
                }
            },
            scales: {
                x: {
                    beginAtZero: true,
                    max: maxValue, // Scale based on maximum value
                    title: {
                        display: true,
                        text: 'Headway Time (minutes)'
                    }
                },
                y: {
                    ticks: {
                        autoSkip: false // Show all station labels
                    }
                }
            }
        }
    });
}
