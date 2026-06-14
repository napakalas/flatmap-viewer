/*==============================================================================

Flatmap viewer and annotation tool

Copyright (c) 2019  David Brooks

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.

==============================================================================*/


// biome-ignore lint/suspicious/noShadowRestrictedNames: use improved `set` code
import  Set from 'core-js/actual/set'
import maplibregl from 'maplibre-gl'

//import {default as turfArea} from '@turf/area'
import {default as turfAlong} from '@turf/along'
import {default as turfBBox} from '@turf/bbox'
import * as turf from '@turf/helpers'
import * as turfCleanCoords from "@turf/clean-coords"
import * as turfNearestPointOnLine from "@turf/nearest-point-on-line"
import * as turfProjection from '@turf/projection'

import polylabel from 'polylabel'

//==============================================================================

import {PropertiesFilter} from './filters'
import {NerveCentreFacet} from './filters/facets/nerve'
import {PathTypeFacet} from './filters/facets/pathtype'
import {TaxonFacet} from './filters/facets/taxon'
import type {PropertiesFilterExpression} from './filters'
import type {AnnotatedFeature, AnnotationDrawMode, AnnotationEvent,
        FlatMapFeature, FlatMapFeatureAnnotation,
        FlatMapMarkerOptions, FlatMapPopUpOptions, FlatMapState, MapFeature,
        MapFeatureIdentifier, MapPointFeature, MapRenderedFeature} from './flatmap-types'
import type {BoundingBox, DatasetTerms, FeatureZoomOptions, GeoJSONId} from './flatmap-types'
import type {MinimapOptions, Point2D} from './flatmap-types'
import {type FlatMap, FLATMAP_STYLE} from './flatmap'
import {isMarker, LayerManager} from './layers'
import {ANATOMICAL_MARKERS_LAYER} from './layers/acluster'
import {MARKERS_LAYER_ID_SUFFIX} from './layers/markers'
import {VECTOR_TILES_SOURCE} from './layers/styling'
import {MARKER_DEFAULT_COLOUR} from './markers'
import {latex2Svg} from './mathjax'
import type {NerveCentrelineDetails} from './pathways'
import {PathManager, PATHWAYS_LAYER} from './pathways'
import {SystemsManager} from './systems'

import {displayedProperties, InfoControl} from './controls/info'
import {AnnotatorControl, BackgroundControl, ClosePaneControl, LayerControl, NavigationControl, SCKANControl} from './controls/controls'
import {AnnotationDrawControl, DRAW_ANNOTATION_LAYERS} from './controls/annotation'
import {NerveCentrelineControl} from './controls/nerves'
import {PathControl} from './controls/paths'
import {FlightPathControl} from './controls/flightpaths'
import {SearchControl} from './controls/search'
import {MinimapControl} from './controls/minimap'
import {SystemsControl} from './controls/systems'
import {TaxonsControl} from './controls/taxons'

import * as utils from './utils'

//==============================================================================
/*
{
    children?: number[]
}
*/

//==============================================================================

// FUTURE
// smallest `group` features when zoom < SHOW_DETAILS_ZOOM if there are some, otherwise smallest feature
// if no non-group features then smallest group one

//export const SHOW_DETAILS_ZOOM = 6

//==============================================================================

function featureBounds(feature: MapRenderedFeature): BoundingBox
//==============================================================
{
    // Find the feature's bounding box

    const bounds = ('bounds' in feature.properties) ? feature.properties.bounds
                                                    : feature.properties.bbox
    if (bounds) {
        // Bounding box is defined in GeoJSON

        return JSON.parse(bounds)
    } else if (feature.geometry.type === 'Polygon') {
        // Get the bounding box of the current polygon. This won't neccessary
        // be the full feature because of tiling

        const polygon = turf.geometry(feature.geometry.type, feature.geometry.coordinates)
        return turfBBox(polygon) as BoundingBox
    }
    return [0, 0, 0, 0]
}

//==============================================================================

function expandBounds(bbox1:BoundingBox|null, bbox2:BoundingBox|null, _pad: number=0): BoundingBox|null
//=====================================================================================================
{
    if (bbox1 === null) {
        if (bbox2 === null) {
            return null
        } else {
            return [...bbox2]
        }
    } else if (bbox2 === null) {
        return [...bbox1]
    } else {
        return [Math.min(bbox1[0], bbox2[0]), Math.min(bbox1[1], bbox2[1]),
                Math.max(bbox1[2], bbox2[2]), Math.max(bbox1[3], bbox2[3])]
    }
}

//==============================================================================

function labelPosition(feature: FlatMapFeature|GeoJSON.Feature): [number, number]
{
    let coords: number[] = [0, 0]
    if (feature.geometry.type === 'Point') {
        coords = feature.geometry.coordinates
    } else if (feature.geometry.type === 'Polygon') {
        const polygon = feature.geometry.coordinates
        // Rough heuristic. Area is in km^2; below appears to be good enough.
        const precision = ('area' in feature.properties)
                            ? Math.sqrt(feature.properties.area)/500000
                            : 0.1
        coords = polylabel(polygon, precision)
    }
    return [coords[0], coords[1]]
}

//==============================================================================

function getRenderedLabel(properties)
{
    if (!('renderedLabel' in properties)) {
        const label = ('label' in properties) ? properties.label
                    : ('user_label' in properties) ? properties.user_label
                    : ''
        const uppercaseLabel = (label !== '') ? (label.substr(0, 1).toUpperCase()
                                               + label.substr(1)).replaceAll("\n", "<br/>")
                                              : ''
        properties.renderedLabel = uppercaseLabel.replaceAll(/\$([^$]*)\$/g, math => latex2Svg(math.slice(1, -1)))
    }
    return properties.renderedLabel
}

//==============================================================================

export class UserInteractions
{
    static readonly #HUMAN_SENMOT_FLATMAP_ID = 'human-senmot-flatmap'
    static readonly #HUMAN_SENMOT_HACS_LINK = 'https://www.figma.com/community/file/1320468164820924031'
    static readonly #HUMAN_SENMOT_CORNER_LABEL_PREFIX = 'Anatomy layers based on '
    static readonly #HUMAN_SENMOT_CORNER_LABEL_SUFFIX = ', used under CC BY 4.0. Modified with custom map markers, coordinate polygons, and data annotations.'

    #activeFeatures: Map<GeoJSONId, MapFeature> = new Map()
    #activeMarker: maplibregl.Marker|null = null
    #annotationByMarkerId = new Map()
    #annotationDrawControl: AnnotationDrawControl|null = null
    #closeControl: ClosePaneControl|null = null
    #colourOptions
    #currentPopup: maplibregl.Popup|null = null
    #featureEnabledCount: Map<GeoJSONId, number>
    #featureIdToMapId: Map<string, GeoJSONId>
    #featureZoomRangesBySourceLayer: Map<string, Map<GeoJSONId, Array<[number|null, number|null]>>> = new Map()
    #flatmap: FlatMap
    #imageLayerIds = new Map()
    #infoControl: InfoControl|null = null
    #lastClickLngLat: maplibregl.LngLat|null = null
    #lastFeatureMouseEntered: number|null = null
    #lastFeatureModelsMouse: string|null = null
    #lastImageId: number = 0
    #lastMarkerId: number = 900000
    #lastMousePoint: [number, number]|null = null
    #layerManager: LayerManager
    #map: maplibregl.Map
    #markerIdByFeatureId = new Map()
    #markerIdByMarker: Map<maplibregl.Marker, number> = new Map()
    #markerPositions: Map<number, [number, number]> = new Map() // Where to put labels and popups on a feature
    #minimap: MinimapControl|null = null
    #modal: boolean = false
    #nerveCentrelineFacet: NerveCentreFacet
    #pan_zoom_enabled: boolean = false
    #pathLowDensityMode: boolean = false
    #pathManager: PathManager
    #pathTypeFacet: PathTypeFacet
    #selectedFeatureRefCount = new Map()
    #systemsManager: SystemsManager
    #taxonFacet: TaxonFacet
    #tooltip: maplibregl.Popup|null = null
    #resetOnClickEnabled: boolean = true
    #collectingActiveFeatures: boolean = false
    #nextActiveFeatures: Map<GeoJSONId, MapFeature>|null = null

    constructor(flatmap: FlatMap)
    {
        this.#flatmap = flatmap
        this.#map = flatmap.map

        // Default colour settings
        this.#colourOptions = {coloured: true, outlined: true}

        // Track enabled features

        this.#featureEnabledCount = new Map(Array.from(this.#flatmap.annotations.keys()).map(k => [k, 0]))

        const featuresEnabled = flatmap.options.style !== FLATMAP_STYLE.FUNCTIONAL

        const tooltipDelay = flatmap.options.tooltipDelay || 0

        // Path visibility is either controlled externally or by a local control
        // FC path visiblitity is determined by system visiblity

        this.#pathManager = new PathManager(flatmap, this)

        // The path types in this map

        const mapPathTypes = this.#pathManager.pathTypes()

        // Add and manage our layers. NB. This needs to be done after we
        // have a path manager but before paths are enabled

        this.#layerManager = new LayerManager(flatmap, this)

        // Set initial enabled state of paths
        this.#pathManager.enablePathLines(true, true)

        this.#pathTypeFacet = new PathTypeFacet(mapPathTypes)
        this.#layerManager.addFilteredFacet(this.#pathTypeFacet)

        this.#nerveCentrelineFacet = new NerveCentreFacet(this.#pathManager.nerveCentrelineDetails)
        this.#layerManager.addFilteredFacet(this.#nerveCentrelineFacet)

        // Note features that are FC systems
        this.#systemsManager = new SystemsManager(this.#flatmap, this, featuresEnabled)

        // All taxons of connectivity paths are enabled by default
        this.#taxonFacet = new TaxonFacet(this.#flatmap.taxonIdentifiers)
        this.#layerManager.addFilteredFacet(this.#taxonFacet)

        // Add a minimap if option set
        if (flatmap.options.minimap) {
            const options: MinimapOptions = (typeof flatmap.options.minimap === 'object')
                                           ? flatmap.options.minimap
                                           : {}
            this.createMinimap(options)
        }

        // Do we want a fullscreen control?
        if (flatmap.options.fullscreenControl === true) {
            this.#map.addControl(new maplibregl.FullscreenControl(), 'top-right')
        }

        // Add navigation controls if option set
        if (flatmap.options.navigationControl) {
            const value = flatmap.options.navigationControl
            const position = ((typeof value === 'string')
                           && ['top-left', 'top-right', 'bottom-right', 'bottom-left'].includes(value))
                           ? value : 'bottom-right'
            this.#map.addControl(new NavigationControl(flatmap), <maplibregl.ControlPosition>position)
        }

        // Optionally add a close pane control

        if (flatmap.options.addCloseControl) {
            this.addCloseControl()
        }

        // Add various controls when running standalone
        if (flatmap.options.standalone) {
            // Add a control to search annotations if option set
            this.#map.addControl(new SearchControl(flatmap))

            // Control background colour (NB. this depends on having map layers created)
            this.#map.addControl(new BackgroundControl(flatmap))

            // Remaining controls only show if we want all of them

            if (flatmap.options.allControls) {

                // Show information about features
                this.#infoControl = new InfoControl(flatmap)
                this.#map.addControl(this.#infoControl)

                // Add a control to manage our paths
                this.#map.addControl(new PathControl(flatmap, mapPathTypes))

                // Add a control for nerve centrelines if they are present
                if (flatmap.options.style === FLATMAP_STYLE.ANATOMICAL && this.#pathManager.haveCentrelines) {
                    this.#map.addControl(new NerveCentrelineControl(flatmap, this))
                }

                if (flatmap.options.style === FLATMAP_STYLE.FUNCTIONAL) {
                    // SCKAN path and SYSTEMS controls for FC maps
                    this.#map.addControl(new SystemsControl(flatmap, this.#systemsManager.systems))
                    this.#map.addControl(new SCKANControl(flatmap, flatmap.options.layerOptions))
                } else {
                    // Connectivity taxon control for AC maps
                    this.#map.addControl(new TaxonsControl(flatmap))
                }

                if (flatmap.hasFlightpaths) {
                    this.#map.addControl(new FlightPathControl(flatmap, !!flatmap.options.flightPaths))
                }

                if (flatmap.options.annotator) {
                    this.#map.addControl(new AnnotatorControl(flatmap))
                }

                // Add a control to control layer visibility
                this.#map.addControl(new LayerControl(flatmap, this.#layerManager))
            }
        }

        this.#addMapCornerLabel()

        // Initialise map annotation
        this.#setupAnnotation()

        // Add an initially hidden tool for drawing on the map.
        this.#annotationDrawControl = new AnnotationDrawControl(flatmap, false)
        this.#map.addControl(this.#annotationDrawControl)

        // Set initial path viewing mode
        if (flatmap.options.flightPaths === true) {
            this.#layerManager.setFlightPathMode(true)
        }

        // Handle mouse events

        const handleMouseMoveEvent = this.#mouseMoveEvent.bind(this)
        this.#map.on('click', this.#clickEvent.bind(this))
        this.#map.on('dblclick', event => {
            const clickedFeatures = this.#layerManager.featuresAtPoint(event.point)
            for (const feature of clickedFeatures) {
                if (feature.properties && feature.properties.kind === 'expandable'
                 && this.#map.getZoom() > (feature.properties.maxzoom - 2)
                 && 'geometry' in feature) {
                    event.preventDefault()
                    this.#map.fitBounds(featureBounds(feature), {
                        padding: 0,
                        animate: false
                    })
                    break
                }
            }
        })
        this.#map.on('touchend', this.#clickEvent.bind(this))
        this.#map.on('mousemove', utils.delay(handleMouseMoveEvent, tooltipDelay))

        // Handle pan/zoom events
        this.#map.on('move', this.#panZoomEvent.bind(this, 'pan'))
        this.#map.on('zoom', this.#panZoomEvent.bind(this, 'zoom'))
        this.#map.on('zoomend', this.#panZoomEvent.bind(this, 'zoomend'))
        this.#map.on('moveend', this.#panZoomEvent.bind(this, 'moveend'))

        // Prime path density so initial rendering and hit-testing are in sync.
        this.#updateAreaDensity(true)
    }

    #addMapCornerLabel()
    //===================
    {
        if (this.#flatmap.id !== UserInteractions.#HUMAN_SENMOT_FLATMAP_ID) {
            return
        }

        const mapContainer = this.#map.getContainer()
        const elementId = `${this.#flatmap.uniqueId}-corner-label`
        if (mapContainer.querySelector(`#${elementId}`)) {
            return
        }

        const label = document.createElement('div')
        label.id = elementId
        label.className = 'flatmap-corner-label'

        const hacsLink = document.createElement('a')
        hacsLink.href = UserInteractions.#HUMAN_SENMOT_HACS_LINK
        hacsLink.target = '_blank'
        hacsLink.rel = 'noopener noreferrer'
        hacsLink.textContent = 'Human Anatomy Component System'

        label.append(UserInteractions.#HUMAN_SENMOT_CORNER_LABEL_PREFIX)
        label.append(hacsLink)
        label.append(UserInteractions.#HUMAN_SENMOT_CORNER_LABEL_SUFFIX)
        mapContainer.appendChild(label)
    }

    get minimap()
    //===========
    {
        return this.#minimap
    }

    closeMinimap()
    //============
    {
        if (this.#minimap) {
            this.#map.removeControl(this.#minimap)
            this.#minimap = null
        }
    }

    createMinimap(options: MinimapOptions={})
    //=======================================
    {
        if (this.#minimap == null) {
            this.#minimap = new MinimapControl(this.#flatmap, options,
                this.#layerManager.minimapStyleSpecification)
            this.#map.addControl(this.#minimap)
        }
    }

    get pathManager()
    //===============
    {
        return this.#pathManager
    }

    addCloseControl()
    //===============
    {
        if (this.#closeControl === null) {
            this.#closeControl = new ClosePaneControl(this.#flatmap)
            this.#map.addControl(this.#closeControl)
        }
    }

    removeCloseControl()
    //==================
    {
        if (this.#closeControl) {
            this.#map.removeControl(this.#closeControl)
            this.#closeControl = null
        }
    }

    getState(): FlatMapState
    //======================
    {
        // Return the map's centre, zoom, bearing and pitch
        // Can only be called when the map is fully loaded
        return {
            center: this.#map.getCenter().toArray(),
            zoom: this.#map.getZoom(),
            bearing: this.#map.getBearing(),
            pitch: this.#map.getPitch()
        }
    }

    setState(state)
    //=============
    {
        // Restore the map to a saved state

        const options = Object.assign({}, state)
        if ('zoom' in options) {
            if ('center' in options) {
                options.around = options.center
            } else {
                options.around = [0, 0]
            }
        }
        if (Object.keys(options).length > 0) {
            this.#map.jumpTo(options)
        }
    }

    showAnnotator(visible=true)
    //=========================
    {
        if (this.#annotationDrawControl) {
            this.#annotationDrawControl.show(visible)
        }
    }

    commitAnnotationEvent(event: AnnotationEvent)
    //===========================================
    {
        if (this.#annotationDrawControl) {
            this.#annotationDrawControl.commitEvent(event)
        }
    }

    abortAnnotationEvent(event: AnnotationEvent)
    //==========================================
    {
        if (this.#annotationDrawControl) {
            this.#annotationDrawControl.abortEvent(event)
        }
    }

    rollbackAnnotationEvent(event: AnnotationEvent)
    //=============================================
    {
        if (this.#annotationDrawControl) {
            this.#annotationDrawControl.rollbackEvent(event)
        }
    }

    clearAnnotationFeatures()
    //=======================
    {
        if (this.#annotationDrawControl) {
            this.#annotationDrawControl.clearFeatures()
        }
    }

    removeAnnotationFeature()
    //=======================
    {
        if (this.#annotationDrawControl) {
            this.#annotationDrawControl.removeFeature()
        }
    }

    addAnnotationFeature(feature: AnnotatedFeature)
    //=============================================
    {
        if (this.#annotationDrawControl) {
            this.#annotationDrawControl.addFeature(feature)
        }
    }

    refreshAnnotationFeatureGeometry(feature: AnnotatedFeature)
    //=========================================================
    {
        if (this.#annotationDrawControl) {
            return this.#annotationDrawControl.refreshGeometry(feature)
        }
    }

    changeAnnotationDrawMode(mode: AnnotationDrawMode)
    //================================================
    {
        if (this.#annotationDrawControl) {
            this.#annotationDrawControl.changeMode(mode)
        }
    }

    #setupAnnotation()
    //================
    {
        // Relate external annotation identifiers to map (GeoJSON) ids
        this.#featureIdToMapId = new Map([...this.#flatmap.annotations.entries()]
                                                 .map(idAnn => [idAnn[1].id, idAnn[0]]))
        // Flag features that have annotations
        for (const mapId of this.#featureIdToMapId.values()) {
            const feature = this.mapFeature(mapId)
            if (feature) {
                this.#map.setFeatureState(feature, { 'map-annotation': true })
            }
        }
    }

    setFeatureAnnotated(featureId: string)
    //====================================
    {
        // External feature id to map's GeoJSON id
        const mapId = this.#featureIdToMapId.get(featureId)
        if (mapId) {
            const feature = this.mapFeature(mapId)
            if (feature) {
                this.#map.setFeatureState(feature, { 'annotated': true })
            }
        }
    }

    #setPaint(options)
    //================
    {
        this.#layerManager.setPaint(options)
    }

    setPaint(options)
    //===============
    {
        this.#colourOptions = options
        this.#setPaint(options)
    }

    getLayers()
    //=========
    {
        return this.#layerManager.layers
    }

    enableLayer(layerId: string, enable=true)
    //=======================================
    {
        this.#layerManager.activate(layerId, enable)
    }

    /**
     * Free up gl context used in layermanager, only call this when
     * the GL context is lost
     *
     */
    freeLayersResource()
    //==================
    {
        this.#layerManager.freeDeckGLResource()
    }

    enableFlightPaths(enable=true)
    //============================
    {
        this.#layerManager.setFlightPathMode(enable)
    }

    getSystems()
    //==========
    {
        return this.#systemsManager.systems
    }

    enableSystem(systemId: string, enable=true)
    //=========================================
    {
        this.#systemsManager.enable(systemId, enable)
    }

    mapFeatureFromAnnotation(annotation: FlatMapFeatureAnnotation|null): MapFeature|null
    //==================================================================================
    {
        if (annotation) {
            return {
                id: annotation.featureId,
                source: VECTOR_TILES_SOURCE,
                sourceLayer: (this.#flatmap.options.separateLayers
                             ? `${annotation.layer}_${annotation['tile-layer']}`
                             : annotation['tile-layer']).replaceAll('/', '_'),
                children: annotation.children || [],
                properties: {}
            }
        }
        return null
    }

    mapFeature(geojsonId: GeoJSONId): MapFeature|null
    //===============================================
    {
        return this.mapFeatureFromAnnotation(this.#flatmap.annotation(geojsonId))
    }

    #markerToFeature(feature: MapFeature|MapRenderedFeature): MapFeature|null
    //=======================================================================
    {
        if (isMarker(feature)) {
            return this.mapFeature(feature.properties.featureId || -1)
        }
        return feature
    }

    #getFeatureState(feature: MapFeature|MapRenderedFeature)
    //======================================================
    {
        const mapFeature = this.#markerToFeature(feature)
        if (mapFeature) {
            return this.#map.getFeatureState(mapFeature)
        }
    }


    getFeatureState(featureId: GeoJSONId)
    //===================================
    {
        const feature = this.mapFeature(featureId)
        if (feature) {
            const state = this.#map.getFeatureState(feature)
            if (Object.keys(state).length) {
                return state
            }
        }
        return null
    }

    #removeFeatureState(feature: MapFeature|MapRenderedFeature, key: string)
    //======================================================================
    {
        const mapFeature = this.#markerToFeature(feature)
        if (mapFeature) {
            this.#map.removeFeatureState(mapFeature, key)
        }
        this.#layerManager.removeFeatureState(+feature.id, key)
    }

    #setFeatureState(feature: MapFeature|MapRenderedFeature, state)
    //=============================================================
    {
        const mapFeature = this.#markerToFeature(feature)
        if (mapFeature) {
            this.#map.setFeatureState(mapFeature, state)
        }
        this.#layerManager.setFeatureState(+feature.id, state)
    }

    enableMapFeature(feature: MapFeature|null, enable=true)
    //=====================================================
    {
        if (feature) {
            const state = this.#getFeatureState(feature)
            if  ('hidden' in state) {
                if (enable) {
                    this.#removeFeatureState(feature, 'hidden')
                } else if (!state.hidden) {
                    this.#setFeatureState(feature, { hidden: true })
                }
            } else if (!enable) {
                this.#setFeatureState(feature, { hidden: true })
            }
            this.#enableFeatureMarker(+feature.id, enable)
        }
    }

    enableFeature(featureId: GeoJSONId, enable=true, force=false)
    //===========================================================
    {
        const enabledCount = this.#featureEnabledCount.get(+featureId) || 0
        if (force || enable && enabledCount === 0 || !enable && enabledCount === 1) {
            this.enableMapFeature(this.mapFeature(+featureId), enable)
        }
        if (force) {
            this.#featureEnabledCount.set(featureId, enable ? 1 : 0)
        } else {
            this.#featureEnabledCount.set(featureId, enabledCount + (enable ? 1 : -1))
        }
    }

    enableFeatureWithChildren(featureId: GeoJSONId, enable=true, force=false)
    //=======================================================================
    {
        const feature = this.mapFeature(featureId)
        if (feature) {
            this.enableFeature(featureId, enable, force)
            for (const childFeatureId of feature.children || []) {
                this.enableFeatureWithChildren(childFeatureId, enable, force)
            }
        }
    }

    #enableFeatureMarker(featureId: GeoJSONId, enable=true)
    //=====================================================
    {
        const markerId = this.#markerIdByFeatureId.get(featureId)
        if (markerId) {
            const markerDiv = document.getElementById(`marker-${markerId}`)
            if (markerDiv) {
                markerDiv.style.visibility = enable ? 'visible' : 'hidden'
            }
        }
    }

    #featureEnabled(feature: MapFeatureIdentifier|null): boolean
    //==========================================================
    {
        if (feature === null) {
            return false
        } else if (feature.id) {
            const state = this.#getFeatureState(feature)
            return (state
                && !(state.hidden || false)
                && !(state.invisible || false))
        }
        return DRAW_ANNOTATION_LAYERS.includes(feature.layer.id)
    }

    #featureSelected(featureId: GeoJSONId): boolean
    //=============================================
    {
        return this.#selectedFeatureRefCount.has(+featureId)
    }

    selectFeature(featureId: GeoJSONId, dim=true)
    //===========================================
    {
        const ann = this.#flatmap.annotation(featureId)
        if (ann && 'sckan' in ann) {
            const sckanState = this.#layerManager.sckanState
            if (sckanState === 'none'
             || sckanState === 'valid' && !ann.sckan
             || sckanState === 'invalid' && ann.sckan) {
                return false
            }
        }
        featureId = +featureId;   // Ensure numeric
        let result = false
        const noSelection = (this.#selectedFeatureRefCount.size === 0)
        if (this.#selectedFeatureRefCount.has(featureId)) {
            this.#selectedFeatureRefCount.set(featureId, this.#selectedFeatureRefCount.get(featureId) + 1)
            result = true
        } else {
            const feature = this.mapFeature(featureId)
            if (feature) {
                const state = this.#getFeatureState(feature)
                if (state && (!('hidden' in state) || !state.hidden)) {
                    this.#setFeatureState(feature, { selected: true })
                    this.#selectedFeatureRefCount.set(featureId, 1)
                    result = true
                }
            }
        }
        if (result && noSelection) {
            this.#setPaint({...this.#colourOptions, dimmed: dim})
        }
        return result
    }

    unselectFeature(featureId: GeoJSONId)
    //===================================
    {
        featureId = +featureId;   // Ensure numeric
        if (this.#selectedFeatureRefCount.has(+featureId)) {
            const refCount = this.#selectedFeatureRefCount.get(featureId)
            if (refCount > 1) {
                this.#selectedFeatureRefCount.set(+featureId, refCount - 1)
            } else {
                const feature = this.mapFeature(+featureId)
                if (feature) {
                    this.#removeFeatureState(feature, 'selected')
                    this.#selectedFeatureRefCount.delete(+featureId)
                }
            }
        }
        if (this.#selectedFeatureRefCount.size === 0) {
            this.#setPaint({...this.#colourOptions, dimmed: false})
        }
    }

    unselectFeatures()
    //================
    {
        for (const featureId of this.#selectedFeatureRefCount.keys()) {
            const feature = this.mapFeature(featureId)
            if (feature) {
                this.#removeFeatureState(feature, 'selected')
            }
        }
        this.#selectedFeatureRefCount.clear()
        this.#setPaint({...this.#colourOptions, dimmed: false})
    }

    activateFeature(feature: MapFeature|MapRenderedFeature|null)
    //==========================================================
    {
        if (feature) {
            const activeMap = this.#collectingActiveFeatures ? this.#nextActiveFeatures
                                                             : this.#activeFeatures
            if (activeMap && activeMap.has(+feature.id)) {
                return
            }
            if (this.#collectingActiveFeatures) {
                this.#nextActiveFeatures?.set(+feature.id, feature)
            } else {
                this.#setFeatureState(feature, { active: true })
                if (!this.#activeFeatures.has(+feature.id)) {
                    this.#activeFeatures.set(+feature.id, feature)
                }
            }
            // If the feature is a nerve, activate its inner features too
            for (const innerFeatureId of this.#flatmap.featureIdsByNerveId(+feature.id)) {
                if (+feature.id !== innerFeatureId){
                    this.activateFeature(this.mapFeature(+innerFeatureId))
                }
            }
        }
    }

    activateLineFeatures(lineFeatures: MapPointFeature[])
    //===================================================
    {
        for (const lineFeature of lineFeatures) {
            this.activateFeature(lineFeature)
            const lineIds: Set<GeoJSONId> = new Set(lineFeatures.map(f => f.properties.featureId))
            for (const featureId of this.#pathManager.lineFeatureIds(lineIds)) {
                this.activateFeature(this.mapFeature(featureId))
            }
        }
    }

    #beginActiveFeatureUpdate()
    //=========================
    {
        this.#collectingActiveFeatures = true
        this.#nextActiveFeatures = new Map()
    }

    #commitActiveFeatureUpdate()
    //==========================
    {
        const nextActiveFeatures = this.#nextActiveFeatures || new Map()

        for (const [featureId, feature] of this.#activeFeatures.entries()) {
            if (!nextActiveFeatures.has(featureId)) {
                this.#removeFeatureState(feature, 'active')
            }
        }

        for (const [featureId, feature] of nextActiveFeatures.entries()) {
            if (!this.#activeFeatures.has(featureId)) {
                this.#setFeatureState(feature, { active: true })
            }
        }

        this.#activeFeatures = nextActiveFeatures
        this.#collectingActiveFeatures = false
        this.#nextActiveFeatures = null
    }

    #resetActiveFeatures()
    //====================
    {
        for (const feature of this.#activeFeatures.values()) {
            this.#removeFeatureState(feature, 'active')
        }
        this.#activeFeatures.clear()
        this.#collectingActiveFeatures = false
        this.#nextActiveFeatures = null
    }

    /* UNUSED
    #smallestAnnotatedPolygonFeature(features)
    //========================================
    {
        // Get the smallest feature from a list of features

        let smallestArea = 0
        let smallestFeature = null
        for (const feature of features) {
            if (feature.geometry.type.includes('Polygon')
             && this.#getFeatureState(feature)['map-annotation']) {
                const polygon = turf.geometry(feature.geometry.type, feature.geometry.coordinates)
                const area = turfArea(polygon)
                if (smallestFeature === null || smallestArea > area) {
                    smallestFeature = feature
                    smallestArea = area
                }
            }
        }
        return smallestFeature
    }
    */

    #setModal()
    //=========
    {
        this.#modal = true
    }

    #clearModal()
    //===========
    {
        this.#modal = false
    }

    reset()
    //=====
    {
        this.#clearModal()
        this.#clearActiveMarker()
        this.unselectFeatures()
    }

    clearSearchResults(_reset=true)
    //=============================
    {
        this.unselectFeatures()
    }

    /**
     * Select features on the map.
     *
     * @param  featureIds  An array of feature identifiers to highlight
     */
    selectFeatures(featureIds: GeoJSONId[])
    //=====================================
    {
        if (featureIds.length) {
            this.unselectFeatures()
            for (const featureId of featureIds) {
                const annotation = this.#flatmap.annotation(featureId)
                if (annotation) {
                    if (this.selectFeature(featureId)) {
                        if (annotation.type?.startsWith('line')) {
                            for (const pathFeatureId of this.#pathManager.lineFeatureIds([+featureId])) {
                                this.selectFeature(pathFeatureId)
                            }
                        }
                    }
                }
            }
        }
    }

    showSearchResults(featureIds: GeoJSONId[])
    //========================================
    {
        this.unselectFeatures()
        this.zoomToFeatures(featureIds, {zoomIn: false})
    }

    zoomToFeatures(featureIds: GeoJSONId[], options: FeatureZoomOptions)
    //==================================================================
    {
        options = utils.setDefaults(options, {
            zoomIn: false
        })
        if (featureIds.length) {
            this.unselectFeatures()
            let bbox: BoundingBox|null = null
            if (!options.zoomIn) {
                const bounds = this.#map.getBounds().toArray()
                bbox = [...bounds[0], ...bounds[1]]
            }
            for (const featureId of featureIds) {
                const annotation = this.#flatmap.annotation(featureId)
                if (annotation) {
                    if (this.selectFeature(featureId)) {
                        bbox = expandBounds(bbox, annotation.bounds||null)
                        if (annotation.type?.startsWith('line')) {
                            for (const pathFeatureId of this.#pathManager.lineFeatureIds([+featureId])) {
                                if (this.selectFeature(pathFeatureId)) {
                                    const pathAnnotation = this.#flatmap.annotation(pathFeatureId)
                                    if (pathAnnotation) {
                                        bbox = expandBounds(bbox, pathAnnotation.bounds||null)
                                    }
                                }
                            }
                        }
                    }
                }
            }
            if (bbox !== null) {
                this.#map.fitBounds(bbox, {
                    padding: 0,
                    animate: false
                })
            }
        }
    }

    showPopup(featureId: GeoJSONId, content: string, options: FlatMapPopUpOptions={})
    //===============================================================================
    {
        const ann = this.#flatmap.annotation(featureId)
        const drawn = !!options.annotationFeatureGeometry
        if (ann || drawn) {  // The feature exists or it is a drawn annotation

            // Remove any existing popup

            if (this.#currentPopup) {
                if (options?.preserveSelection) {
                    this.#currentPopup.options['preserveSelection'] = options.preserveSelection
                }
                this.#currentPopup.remove()
            }

            // Clear selection if we are not preserving it

            if (options?.preserveSelection) {
                delete options.preserveSelection;       // Don't pass to onClose()
            } else {                                    // via the popup's options
                this.unselectFeatures()
            }

            // Select the feature

            this.selectFeature(featureId)

            // Find the pop-up's postion

            let location: maplibregl.LngLatLike
            if ('positionAtLastClick' in options
               && options.positionAtLastClick
               && this.#lastClickLngLat !== null) {
                location = this.#lastClickLngLat
            } else if (drawn) {
                // Popup at the centroid of the feature
                // Calculated with the feature geometry coordinates
                location = options.annotationFeatureGeometry
            } else {
                // Position popup at the feature's 'centre'
                location = this.markerPosition(ann)
            }

            // Make sure the feature is on screen

            if (!this.#map.getBounds().contains(location)) {
                this.#map.panTo(location)
            }
            this.#setModal()
            this.#currentPopup = new maplibregl.Popup(options).addTo(this.#map)
            this.#currentPopup.on('close', this.#onCloseCurrentPopup.bind(this))
            if (drawn) {
                // If annotationEvent is not provided, create a fallback with available geometry
                const fallbackAnnotationEvent: AnnotationEvent = {
                    type: 'created',
                    feature: {
                        id: featureId,
                        geometry: {
                            type: 'Point',
                            coordinates: options.annotationFeatureGeometry
                        } as GeoJSON.Point,
                    } as AnnotatedFeature
                }
                const annotationEvent: AnnotationEvent = options.annotationEvent || fallbackAnnotationEvent;
                this.#currentPopup.on('close', () => this.abortAnnotationEvent(annotationEvent))
            }
            this.#currentPopup.setLngLat(location)
            if (typeof content === 'object') {
                this.#currentPopup.setDOMContent(content)
            } else {
                this.#currentPopup.setText(content)
            }
        }
    }

    #onCloseCurrentPopup()
    //====================
    {
        if (this.#currentPopup) {
            this.#clearModal()
            if (!(this.#currentPopup.options && this.#currentPopup.options['preserveSelection'])) {
                this.unselectFeatures()
            }
            this.#currentPopup = null
        }
    }

    #removeTooltip()
    //==============
    {
        if (this.#tooltip) {
            this.#tooltip.remove()
            this.#tooltip = null
        }
    }

    /**
     * Remove the currently active popup from the map.
     */
    removePopup()
    //===========
    {
        if (this.#currentPopup) {
            this.#currentPopup.remove()
            this.#currentPopup = null
        }
    }

    #lineTooltip(lineFeatures: MapPointFeature[])
    //===========================================
    {
        const tooltips: string[] = []
        for (const lineFeature of lineFeatures) {
            const properties = lineFeature.properties
            if ('error' in properties) {
                tooltips.push(`<div class="feature-error">Error: ${properties.error}</div>`)
            }
            if ('warning' in properties) {
                tooltips.push(`<div class="feature-error">Warning: ${properties.warning}</div>`)
            }
            if ('label' in properties && (!('tooltip' in properties) || properties.tooltip)) {
                const label = properties.label
                const cleanLabel = (label.substr(0, 1).toUpperCase() + label.substr(1)).replaceAll("\n", "<br/>")
                if (!tooltips.includes(cleanLabel)) {
                    tooltips.push(cleanLabel)
                }
            }
        }
        return (tooltips.length === 0) ? ''
                                       : `<div class='flatmap-feature-label'>${tooltips.join('<hr/>')}</div>`
    }

    #tooltipHtml(properties, forceLabel=false)
    //========================================
    {
        const tooltip: string[] = []
        if ('error' in properties) {
            tooltip.push(`<div class="feature-error">Error: ${properties.error}</div>`)
        }
        if ('warning' in properties) {
            tooltip.push(`<div class="feature-error">Warning: ${properties.warning}</div>`)
        }
        if (('label' in properties
          || 'hyperlink' in properties
          || 'user_label' in properties)
                && (forceLabel || !('tooltip' in properties) || properties.tooltip)) {
            const renderedLabel = getRenderedLabel(properties)
            if ('hyperlink' in properties) {
                if (renderedLabel === '') {
                    tooltip.push(`<a href='${properties.hyperlink}'>${properties.hyperlink}</a>`)
                } else {
                    tooltip.push(`<a href='${properties.hyperlink}'>${renderedLabel}</a></div>`)
                }
            } else {
                tooltip.push(renderedLabel)
            }
        }
        return (tooltip.length === 0) ? ''
                                      : `<div class='flatmap-feature-label'>${tooltip.join('<hr/>')}</div>`
    }

    #featureEvent(type: string, feature: MapPointFeature, values={})
    //==============================================================
    {
        let properties: FlatMapFeatureAnnotation
        if (isMarker(feature)) {
            const markerProperties: object = Object.assign({}, feature.properties, values)
            if (feature.layer.id === ANATOMICAL_MARKERS_LAYER) {
                const markerTerm = markerProperties['models']
                markerProperties['dataset-terms'] = this.#layerManager.datasetTerms(markerTerm)
            }
            return this.#flatmap.markerEvent(type, +feature.id, markerProperties as FlatMapFeatureAnnotation)
        } else if ('properties' in feature) {
            properties = Object.assign({}, feature.properties, values) as FlatMapFeatureAnnotation
            return this.#flatmap.featureEvent(type, properties)
        }
        return false
    }

    #multiFeatureEvent(type: string, featureProperties: FlatMapFeatureAnnotation[])
    //=============================================================================
    {
        return this.#flatmap.featureEvent(type, featureProperties)
    }

    #resetFeatureDisplay()
    //====================
    {
        // Remove any existing tooltip
        this.#removeTooltip()

        // Reset cursor
        this.#map.getCanvas().style.cursor = 'default'

        // Reset any active features
        this.#resetActiveFeatures()
    }

    #renderedFeatures(point: [number, number]): MapPointFeature[]
    //===========================================================
    {
        const features = this.#layerManager.featuresAtPoint(point)
        return features.filter(feature => {
            const featureId = feature.properties?.featureId ?? feature.id
            return this.#featureIdIsRenderable(+featureId)
        })
    }

    #cacheSourceLayerFeatureZoomRanges(sourceLayer: string)
    //===============================================
    {
        if (this.#featureZoomRangesBySourceLayer.has(sourceLayer)) {
            return
        }

        const rangesByFeatureId = new Map<GeoJSONId, Array<[number|null, number|null]>>()
        const features = this.#map.querySourceFeatures(VECTOR_TILES_SOURCE, {sourceLayer})

        for (const feature of features) {
            const featureId: number = feature.id ? +feature.id
                                                    : +feature.properties.featureId

            const minzoomRaw = Number(feature.properties?.minzoom)
            const maxzoomRaw = Number(feature.properties?.maxzoom)
            const minzoom = Number.isFinite(minzoomRaw) ? minzoomRaw : null
            const maxzoom = Number.isFinite(maxzoomRaw) ? maxzoomRaw : null

            const ranges = rangesByFeatureId.get(featureId) || []
            ranges.push([minzoom, maxzoom])
            rangesByFeatureId.set(featureId, ranges)
        }

        this.#featureZoomRangesBySourceLayer.set(sourceLayer, rangesByFeatureId)
    }

    #featureIdIsRenderable(featureId: GeoJSONId): boolean
    //===================================================
    {
        const zoom = Math.floor(this.#map.getZoom())
        const mapFeature = this.mapFeature(+featureId)
        if (!this.#featureEnabled(mapFeature)) {
            return false
        }
        if (mapFeature === null || !mapFeature.sourceLayer) {
            return false
        }

        const sourceLayer = mapFeature.sourceLayer
        const pathwaysSourceLayer = PATHWAYS_LAYER.replaceAll('/', '_')
        const isPathFeature = sourceLayer.includes(pathwaysSourceLayer)

        if (isPathFeature && this.#pathLowDensityMode) {
            return true
        }
        this.#cacheSourceLayerFeatureZoomRanges(sourceLayer)
        const rangesByFeatureId = this.#featureZoomRangesBySourceLayer.get(sourceLayer)
        const ranges = rangesByFeatureId?.get(+featureId)
        if (!ranges || ranges.length === 0) {
            return false
        }

        return ranges.some(([minzoom, maxzoom]) =>
            (minzoom == null || zoom >= minzoom)
         && (maxzoom == null || zoom <= maxzoom)
        )
    }

    #updateAreaDensity(force=false)
    //=================================
    {
        const previousLowDensityMode = this.#pathLowDensityMode
        const renderedFeatures = this.#map.queryRenderedFeatures()
        const visibleEdgeIds = new Set<GeoJSONId>()
        const pathwaysSourceLayer = PATHWAYS_LAYER.replaceAll('/', '_')

        for (const feature of renderedFeatures) {
            const sourceLayer = feature.sourceLayer || ''
            if (feature.source !== VECTOR_TILES_SOURCE || !sourceLayer.includes(pathwaysSourceLayer)) {
                continue
            }
            const pathType = feature.properties?.type
            if (!['line', 'line-dash', 'bezier'].includes(pathType)) {
                continue
            }
            const featureId = feature.properties?.featureId ?? feature.id
            visibleEdgeIds.add(+featureId)
        }

        const PATH_DENSITY_MIN_EDGES = 80
        const PATH_DENSITY_MAX_EDGES = 600
        const PATH_DENSITY_LOW_THRESHOLD = 0.475
        const PATH_DENSITY_HIGH_THRESHOLD = 0.525
        const visibleEdgeCount = visibleEdgeIds.size
        const density = Math.max(0, Math.min(1, (visibleEdgeCount - PATH_DENSITY_MIN_EDGES) / (PATH_DENSITY_MAX_EDGES - PATH_DENSITY_MIN_EDGES)))
        let lowDensityMode = previousLowDensityMode
        if (force) {
            lowDensityMode = (density <= PATH_DENSITY_LOW_THRESHOLD)
        } else if (density <= PATH_DENSITY_LOW_THRESHOLD) {
            lowDensityMode = true
        } else if (density >= PATH_DENSITY_HIGH_THRESHOLD) {
            lowDensityMode = false
        }
        this.#pathLowDensityMode = lowDensityMode

        const lowDensityModeChanged = (this.#pathLowDensityMode !== previousLowDensityMode)
        if (force || lowDensityModeChanged) {
            this.#layerManager.setPaint({
                pathLowDensityMode: this.#pathLowDensityMode
            })
        }
    }

    #mouseMoveEvent(event)
    //====================
    {
        this.#lastMousePoint = event.point
        if (this.#map.isMoving()) {
            return
        }
        this.#updateActiveFeature(event.point, event.lngLat)
    }

    #updateActiveFeature(eventPoint: [number, number], lngLat: maplibregl.LngLat|null=null)
    //=====================================================================================
    {
        // No tooltip when context menu is open
        if (this.#modal) {
            return
        }

        if (this.#map.isMoving()) {
            return
        }

        // Remove tooltip and reset cursor; active features are updated by diff.
        this.#removeTooltip()
        this.#map.getCanvas().style.cursor = 'default'

        // Reset any info display
        const displayInfo = (this.#infoControl?.active)
        if (displayInfo) {
            this.#infoControl.reset()
        }

        const eventLngLat = this.#map.unproject(eventPoint)
        this.#beginActiveFeatureUpdate()

        // Get all the features at the current point
        const features = this.#renderedFeatures(eventPoint)
        if (features.length === 0) {
            this.#lastFeatureMouseEntered = null
            this.#lastFeatureModelsMouse = null
            this.#commitActiveFeatureUpdate()
            if (this.#flatmap.options.showCoords || this.#flatmap.options.showLngLat) {
                this.#showToolTip('', eventLngLat, null)
            }
            return
        }

        // Simulate `mouseenter` events on features

        const feature = features[0]
        const featureId: number = isMarker(feature) ? +feature.id
                                                    : +feature.properties.featureId
        const featureModels = ('properties' in feature && 'models' in feature.properties)
                            ? feature.properties.models
                            : null
        if (this.#lastFeatureMouseEntered !== featureId
         && (this.#lastFeatureModelsMouse === null
          || this.#lastFeatureModelsMouse !== featureModels)) {
            if (this.#featureEvent('mouseenter', feature,
                                    this.#locationOnLine(+featureId, lngLat))) {
                this.#lastFeatureMouseEntered = featureId
                this.#lastFeatureModelsMouse = featureModels
            } else {
                this.#lastFeatureMouseEntered = null
                this.#lastFeatureModelsMouse = null
            }
        } else if (this.#flatmap.options.style === FLATMAP_STYLE.CENTRELINE
                && feature.properties.centreline) {
            if (this.#lastFeatureMouseEntered === featureId) {
                const location = this.#locationOnLine(+featureId, lngLat)
                if ('location' in location) {
                    this.#featureEvent('mousemove', feature, location)
                }
            }
        }

        let info = ''
        let tooltip = ''
        let tooltipFeature: MapPointFeature|null = null
        if (displayInfo) {
            if (!('tooltip' in features[0].properties)) {
                this.activateFeature(feature as MapFeature)
            }
            info = this.#infoControl.featureInformation(features, eventLngLat)
        } else if (this.#flatmap.options.showId) {
            this.activateFeature(feature)
            tooltipFeature = feature
        }
        const lineFeatures = features.filter(feature => ('centreline' in feature.properties
                                                      || ('type' in feature.properties
                                                        && feature.properties.type.startsWith('line')) ))
        if (lineFeatures.length > 0) {
            tooltip = this.#lineTooltip(lineFeatures)
            tooltipFeature = lineFeatures[0]
            this.activateLineFeatures(lineFeatures)
        } else {
            const topSourceLayer = feature.sourceLayer
            let labelledFeatures = features.filter(feature => (feature.sourceLayer === topSourceLayer
                                                         && ('hyperlink' in feature.properties
                                                          || 'label' in feature.properties
                                                          || 'user_label' in feature.properties
                                                          || this.#flatmap.options.showId && 'id' in feature.properties
                                                            )
                                                         && (!('tooltip' in feature.properties)
                                                            || feature.properties.tooltip)))
                                           .sort((a, b) => (a.properties.area - b.properties.area))
            if (labelledFeatures.length > 0) {
                // Favour group features at low zoom levels
                const zoomLevel = this.#map.getZoom()
                const groupFeatures = labelledFeatures.filter(feature => (feature.properties.group
                                                     && zoomLevel < (feature.properties.scale + 1)))
                if (groupFeatures.length > 0) {
                    labelledFeatures = groupFeatures
                }
                const feature = labelledFeatures[0]
                if (feature.properties.user_drawn) {
                    feature.id = feature.properties.id
                }
                tooltip = this.#tooltipHtml(feature.properties)
                tooltipFeature = feature
                if (this.#flatmap.options.debug) {  // Do this when Info on and not debug??
                    const debugProperties = [
                        'featureId',
                        'nerveId',
                        'tile-layer',
                        'type',
                        ...displayedProperties
                    ]
                    const htmlList: string[] = []
                    const featureIds: number[] = []
                    for (const feature of labelledFeatures) {
                        if (!featureIds.includes(+feature.id)) {
                            featureIds.push(+feature.id)
                            for (const prop of debugProperties) {
                                if (prop in feature.properties) {
                                    htmlList.push(`<span class="info-name">${prop}:</span>`)
                                    htmlList.push(`<span class="info-value">${feature.properties[prop]}</span>`)
                                }
                            }
                        }
                        //htmlList.push(`<span class="info-name">Area:</span>`)
                        //htmlList.push(`<span class="info-value">${feature.properties.area/1000000000}</span>`)
                        //htmlList.push(`<span class="info-name">Scale:</span>`)
                        //htmlList.push(`<span class="info-value">${feature.properties.scale}</span>`)
                    }
                    if (!this.#flatmap.options.debug) {
                        info = `<div id="info-control-info">${htmlList.join('\n')}</div>`
                    }
                }
                this.activateFeature(feature)
                this.#activateRelatedFeatures(feature)
                if ('hyperlink' in feature.properties) {
                    this.#map.getCanvas().style.cursor = 'pointer'
                }
            }
        }

        this.#commitActiveFeatureUpdate()

        if (info !== '') {
            this.#infoControl.show(info)
        }
        this.#showToolTip(tooltip, eventLngLat, tooltipFeature)
    }

    #showToolTip(html: string, lngLat: maplibregl.LngLat, feature: MapPointFeature|null=null)
    //=======================================================================================
    {
        // Show a tooltip
        if (html !== ''
         || this.#flatmap.options.showCoords
         || this.#flatmap.options.showLngLat
         || this.#flatmap.options.showId && feature !== null) {
            const header: string[] = []
            if (this.#flatmap.options.showId && feature !== null) {
                if ('id' in feature.properties) {
                    header.push(`${feature.properties.id} (${feature.id})`)
                } else {
                    header.push(`GeoId: ${feature.id})`)
                }
            }
            if (this.#flatmap.options.showCoords) {
                const pt = turf.point(lngLat.toArray())
                const gps = turfProjection.toMercator(pt)
                header.push(JSON.stringify(gps.geometry.coordinates))
            }
            if (this.#flatmap.options.showLngLat) {
                header.push(JSON.stringify(lngLat.toArray()))
            }
            if (header.length) {
                html = `<span>${header.join('<br/>')}</span><br/>${html}`
            }
            if (html !== '') {
                this.#tooltip = new maplibregl.Popup({
                    closeButton: false,
                    closeOnClick: false,
                    maxWidth: 'none',
                    className: 'flatmap-tooltip-popup'
                })
                this.#tooltip
                    .setLngLat(lngLat)
                    .setHTML(html)
                    .addTo(this.#map)
            }
        }
    }

    #selectActiveFeatures(event)
    //==========================
    {
        const singleSelection = !(event.ctrlKey || event.metaKey)
        if (singleSelection) {
            this.unselectFeatures()
        }
        for (const [featureId, feature] of this.#activeFeatures) {
            const dim = !('properties' in feature
                       && 'kind' in feature.properties
                       && ['cell-type', 'scaffold', 'tissue'].includes(feature.properties.kind))
            if (singleSelection) {
                this.selectFeature(featureId, dim)
            } else if (this.#featureSelected(featureId)) {
                this.unselectFeature(featureId)
            } else {
                this.selectFeature(featureId, dim)
            }
        }
    }

    #clickEvent(event)
    //================
    {
        if (this.#modal) {
            return
        }

        // Reset pitch and bearing with an ``alt-meta-click``
        if (event.originalEvent.altKey && event.originalEvent.metaKey) {
            this.#map.resetNorthPitch({animate: false})
            return
        }

        this.#clearActiveMarker()

        let clickedFeatures = this.#renderedFeatures(event.point)
        if (clickedFeatures.length === 0) {
            if (this.#resetOnClickEnabled) {
                this.unselectFeatures()
            }
            return
        }
        const clickedDrawnFeatures = clickedFeatures.filter((f) => !f.id)
        clickedFeatures = clickedFeatures.filter((f) => f.id)
        let clickedFeature = clickedFeatures[0]
        if (this.#flatmap.mapMetadata['map-kinds']?.includes('model')
         && !clickedFeature.layer.id.endsWith(MARKERS_LAYER_ID_SUFFIX)) {
            for (const feature of clickedFeatures) {
                if (feature.properties.variable) {
                    clickedFeature = feature
                    break
                }
            }
        }
        if (this.#modal) {
            if (this.#resetOnClickEnabled) {
                // Remove tooltip, reset active features, etc
                this.#resetFeatureDisplay()
                this.unselectFeatures()
                this.#clearModal()
            }
        } else if (clickedDrawnFeatures.length > 0) {
            // Layer of existing drawn features
            const clickedOnColdLayer = clickedDrawnFeatures.filter((f) => f.source === 'mapbox-gl-draw-cold')[0]
            // Layer of currently drawing feature
            const clickedOnHotLayer = clickedDrawnFeatures.filter((f) => f.source === 'mapbox-gl-draw-hot')[0]
            this.#featureEvent('click',
                clickedOnColdLayer ? clickedOnColdLayer
              : clickedFeature ? clickedFeature
              : clickedOnHotLayer
            )
        } else if (clickedFeatures.length) {
            this.#lastClickLngLat = event.lngLat
            if (this.#flatmap.options.style !== FLATMAP_STYLE.CENTRELINE) {
                this.#selectActiveFeatures(event.originalEvent)
                const lineFeatures = clickedFeatures.filter(feature => ('centreline' in feature.properties
                                                              || ('type' in feature.properties
                                                                && feature.properties.type.startsWith('line')) ))
                if (lineFeatures.length > 0) {
                    this.#multiFeatureEvent('click', lineFeatures.map(f => f.properties))
                } else if (!('details-layer' in clickedFeature.properties)) {
                    this.#featureEvent('click', clickedFeature)
                }
            } else {        // A ``centreline`` map -- we send the click's location along centrelines
                this.#selectActiveFeatures(event.originalEvent)
                const centreline_click = (clickedFeature.properties.kind === 'centreline')
                if (!centreline_click) {
                    this.#featureEvent('click', clickedFeature)
                } else {
                    const seenModels = new Set()
                    const featureProperties: FlatMapFeatureAnnotation[] = []
                    for (const feature of clickedFeatures) {
                        if (feature.properties.models && !seenModels.has(feature.properties.models)) {
                            const location = this.#locationOnLine(+feature.id, event.lngLat)
                            featureProperties.push(Object.assign({}, feature.properties, location) as FlatMapFeatureAnnotation)
                            seenModels.add(feature.properties.models)
                        }
                    }
                    this.#multiFeatureEvent('click', featureProperties)
                }
            }
            if (this.#flatmap.options.style === FLATMAP_STYLE.FUNCTIONAL
             && 'details-layer' in clickedFeature.properties) {
                this.#layerManager.enableDetailedLayer(clickedFeature.properties.layer,
                                                       clickedFeature.properties['details-layer'])
            } else if (this.#flatmap.options.standalone) {
                if ('hyperlink' in clickedFeature.properties) {
                    window.open(clickedFeature.properties.hyperlink, '_blank')
                }
            }
        }
    }

    #locationOnLine(featureId: GeoJSONId, lngLat: maplibregl.LngLat|null)
    //===================================================================
    {
        if (lngLat && this.#flatmap.options.style === FLATMAP_STYLE.CENTRELINE) {
            const annotation = this.#flatmap.annotation(featureId)
            if (annotation?.centreline && 'lineString' in annotation) {
                const line = annotation.lineString
                const clickedPoint = turf.point([lngLat.lng, lngLat.lat])
                const linePoint = turfNearestPointOnLine.nearestPointOnLine(turfCleanCoords.cleanCoords(line), clickedPoint)
                return {
                    location: linePoint.properties.location/annotation.lineLength
                }
            }
        }
        return {}
    }

    #activateRelatedFeatures(feature: MapPointFeature)
    //================================================
    {
        if ('nerveId' in feature.properties) {
            const nerveId = feature.properties.nerveId
            if (nerveId !== feature.id) {
                this.activateFeature(this.mapFeature(+nerveId))
            }
            for (const featureId of this.#pathManager.nerveFeatureIds(nerveId)) {
                if (this.#featureIdIsRenderable(+featureId)) {
                    this.activateFeature(this.mapFeature(+featureId))
                }
            }
        }
        if ('nodeId' in feature.properties) {
            for (const featureId of this.#pathManager.pathFeatureIds(+feature.properties.nodeId)) {
                if (this.#featureIdIsRenderable(+featureId)) {
                    this.activateFeature(this.mapFeature(+featureId))
                }
            }
        }
    }

    clearVisibilityFilter()
    //=====================
    {
        this.#layerManager.clearVisibilityFilter()
    }

    setVisibilityFilter(filterSpecification: PropertiesFilterExpression=true)
    //=======================================================================
    {
        this.#layerManager.setVisibilityFilter(new PropertiesFilter(filterSpecification))
    }

    enablePathsBySystem(system, enable=true, force=false)
    //===================================================
    {
        this.#pathManager.enablePathsBySystem(system, enable, force)
    }

    enablePathsByType(pathTypes: string|string[], enable=true)
    //========================================================
    {
        const types = Array.isArray(pathTypes) ? pathTypes : [pathTypes]
        this.#pathTypeFacet.enable(types, enable)
        if (types.includes('centreline')) {
            this.#nerveCentrelineFacet.enableAllCentrelines(enable)
        }
        this.#layerManager.refresh()
    }

    pathFeatureIds(externalIds: string[]): Set<GeoJSONId>
    //===================================================
    {
        let featureIds = new Set<GeoJSONId>()
        for (const id of externalIds) {
            featureIds = featureIds.union(this.#pathManager.connectivityModelFeatureIds(id))
            featureIds = featureIds.union(this.#pathManager.pathModelFeatureIds(id))
        }
        return featureIds
    }

    pathModelNodes(modelId: string): Set<number>
    //===========================================
    {
        return this.#pathManager.pathModelNodes(modelId)
    }

    nodePathModels(nodeId: GeoJSONId): Set<string>
    //============================================
    {
        return this.#pathManager.nodePathModels(nodeId)
    }

    enableSckanPaths(sckanState: string, enable=true)
    //===============================================
    {
        this.#layerManager.enableSckanPaths(sckanState, enable)
    }

    enableConnectivityByTaxonIds(taxonIds: string|string[], enable=true)
    //==================================================================
    {
        this.#taxonFacet.enable(Array.isArray(taxonIds) ? taxonIds : [taxonIds], enable)
        this.#layerManager.refresh()
    }

    enableFeatureResetOnClick(enable=true)
    //====================================
    {
        this.#resetOnClickEnabled = enable
    }

    excludeAnnotated(exclude=false)
    //=============================
    {
        this.#setPaint({excludeAnnotated: exclude})
    }

    //==============================================================================

    // Marker handling

    markerPosition(annotation: FlatMapFeatureAnnotation, options:FlatMapMarkerOptions={}): Point2D|null
    //=================================================================================================
    {
        const featureId = +annotation.featureId
        if (this.#markerPositions.has(featureId)) {
            return this.#markerPositions.get(featureId)
        }
        if (annotation.centreline && 'location' in options) {
            if ('lineString' in annotation) {
                const line = annotation.lineString
                const point = turfAlong(line, options.location*annotation.lineLength)
                return point.geometry.coordinates as Point2D
            }
            return null
        }
        if (!annotation.markerPosition
         && (!annotation.geometry?.includes('Polygon'))) {
            return null
        }
        let position = annotation.markerPosition || annotation.centroid
        if (!position) {
            // Find where to place a label or popup on a feature
            const features = this.#map.querySourceFeatures(VECTOR_TILES_SOURCE, {
                'sourceLayer': this.#flatmap.options.separateLayers
                                ? `${annotation.layer}_${annotation['tile-layer']}`
                                : annotation['tile-layer'],
                'filter': [
                    'all',
                    [ '==', ['id'], featureId ],
                    [ '==', ['geometry-type'], 'Polygon' ]
                ]
            })
            if (features.length > 0) {
                position = labelPosition(features[0])
            }
        }
        if (position) {
            this.#markerPositions.set(featureId, position)
        }
        return position || null
    }

    nextMarkerId(): number
    //====================
    {
        this.#lastMarkerId += 1
        return this.#lastMarkerId
    }

    addLayeredMarker(anatomicalId: string, options: FlatMapMarkerOptions={}): GeoJSONId[]
    //===================================================================================
    {
        const markerIds: GeoJSONId[] = []
        const featureIds = this.#flatmap.modelFeatureIds(anatomicalId)
        for (const featureId of featureIds) {
            const annotation = this.#flatmap.annotation(featureId)
            if (annotation.kind !== 'zoom-point') {
                const markerId = this.#layerManager.addLayeredMarker(annotation, options)
                if (markerId !== null) {
                    markerIds.push(markerId)
                }
            }
        }
        return markerIds
    }

    addMarker(anatomicalId: string, options: FlatMapMarkerOptions={}): number
    //=======================================================================
    {
        const featureIds = this.#flatmap.modelFeatureIds(anatomicalId)
        let markerId = -1
        for (const featureId of featureIds) {
            markerId = this.addMarkerForFeature(featureId, markerId, options)
        }
        if (markerId === -1) {
            console.warn(`Unable to find feature '${anatomicalId}' on which to place marker`)
        }
        return markerId
    }

    addMarkerForFeature(featureId: number, markerId: number, options: FlatMapMarkerOptions={}): number
    //================================================================================================
    {
        const annotation = this.#flatmap.annotation(featureId)
        const markerPosition = this.markerPosition(annotation, options)
        if (markerPosition === null || annotation.kind === 'zoom-point') {
            return markerId
        }
        if (!options?.colour && !options.element) {
            return this.#layerManager.addLayeredMarker(annotation, options)
        }

        // Only create a marker if there's not already one for the feature
        // NB. If several features have the same anatomical id then each will have
        //     a marker, all with the same marker id
        if (!('marker' in annotation)) {    // where is this set??
            if (markerId === -1) {
                markerId = this.nextMarkerId()
            }

            // MapLibre dynamically sets a transform on marker elements so in
            // order to apply a scale transform we need to create marker icons
            // inside the marker container <div>
            const colour = options.colour || MARKER_DEFAULT_COLOUR
            const markerHTML = options.element ? new maplibregl.Marker({element: options.element})
                                               : new maplibregl.Marker({color: colour, scale: 0.5})
            const markerElement = document.createElement('div')
            const markerIcon = document.createElement('div')
            markerIcon.innerHTML = markerHTML.getElement().innerHTML
            markerElement.id = `marker-${markerId}`
            markerElement.appendChild(markerIcon)
            const markerOptions: maplibregl.MarkerOptions = {element: markerElement}
            if ('className' in options) {
                markerOptions.className = options.className
            }
            const marker = new maplibregl.Marker(markerOptions)
                                         .setLngLat(markerPosition)
                                         .addTo(this.#map)
            markerElement.addEventListener('mouseenter', this.#markerMouseEvent.bind(this, marker))
            markerElement.addEventListener('mousemove', this.#markerMouseEvent.bind(this, marker))
            markerElement.addEventListener('mouseleave', this.#markerMouseEvent.bind(this, marker))
            markerElement.addEventListener('click', this.#markerMouseEvent.bind(this, marker))
            this.#markerIdByMarker.set(marker, markerId)
            if (!this.#featureEnabled(this.mapFeature(featureId))) {
                markerElement.style.visibility = 'hidden'
            }
            this.#markerIdByFeatureId.set(featureId, markerId)
            // Remember that the feature has a marker
            this.#annotationByMarkerId.set(markerId, annotation)
        }
        return markerId
    }

    clearMarkers()
    //============
    {
        this.#layerManager.clearMarkers()
        this.#layerManager.clearLayeredMarkers()
        for (const marker of this.#markerIdByMarker.keys()) {
            marker.remove()
        }
        this.#markerIdByMarker.clear()
        this.#annotationByMarkerId.clear()
    }

    removeMarker(markerId: number)
    //============================
    {
        for (const [marker, id] of this.#markerIdByMarker.entries()) {
            if (markerId === id) {
                marker.remove()
                this.#markerIdByMarker.delete(marker)
                this.#annotationByMarkerId.delete(id)
                break
            }
        }
    }

    addClusteredAnatomicalMarkers(datasets: DatasetTerms[]): DatasetTerms[]
    //=====================================================================
    {
        if (this.#layerManager) {
            return this.#layerManager.addClusteredAnatomicalMarkers(datasets)
        }
        return []
    }

    clearClusteredAnatomicalMarkers()
    //===============================
    {
        if (this.#layerManager) {
            this.#layerManager.clearClusteredAnatomicalMarkers()
        }
    }

    removeClusteredAnatomicalMarker(datasetId: string)
    //================================================
    {
        if (this.#layerManager) {
            this.#layerManager.removeClusteredAnatomicalMarker(datasetId)
        }
    }

    visibleMarkerAnatomicalIds()
    //==========================
    {
        const anatomicalIds: string[] = []
        const visibleBounds = this.#map.getBounds()
        for (const [marker, id] of this.#markerIdByMarker.entries()) {
            if (visibleBounds.contains(marker.getLngLat())) {
                const annotation = this.#annotationByMarkerId.get(id)
                if (!anatomicalIds.includes(annotation.models)) {
                    anatomicalIds.push(annotation.models)
                }
            }
        }
        return anatomicalIds
    }

    #markerMouseEvent(marker: maplibregl.Marker, event)
    //=================================================
    {
        // Ignore marker events when context menu is open
        if (this.#modal) {
            return
        }

        // Remove any tooltips
        this.#removeTooltip()

        if (['mouseenter', 'mousemove', 'click'].includes(event.type)) {
            this.#activeMarker = marker

            // Remove any marker popup
            marker.setPopup(null)

            // Reset cursor
            marker.getElement().style.cursor = 'default'

            const markerId = this.#markerIdByMarker.get(marker)
            if (markerId) {
                const annotation = this.#annotationByMarkerId.get(markerId)

                // Finish marker event event processing and send it to the app
                this.handleMarkerEvent(event, markerId, marker.getLngLat().toArray(), annotation)
            }
            event.stopPropagation()
        }
    }

    handleMarkerEvent(event, markerId: number, markerPosition: [number, number], annotation)
    //================================================================================
    {
        if (['mousemove', 'click'].includes(event.type)) {

            // Remove any tooltips
            this.#removeTooltip()
        }
        if (['mouseenter', 'mousemove', 'click'].includes(event.type)) {
            // The marker's feature
            const feature = this.mapFeature(annotation.featureId)
            if (feature) {
                if (event.type === 'mouseenter') {
                    // Highlight on mouse enter
                    this.#resetActiveFeatures()
                    this.activateFeature(feature)
                } else if (event.type === 'click') {
                    // This though selects active features which might not be the feature
                    // that the marker is for, i.e. `feature`
                    this.#selectActiveFeatures(event)
                }
            }
            // Show tooltip
            const html = this.#tooltipHtml(annotation, true)
            this.#showToolTip(html, new maplibregl.LngLat(...markerPosition))

            // Send marker event message
            this.#flatmap.markerEvent(event.type, markerId, annotation)
        }
    }

    #clearActiveMarker()
    //==================
    {
        if (this.#activeMarker !== null) {
            this.#activeMarker.setPopup(null)
            this.#activeMarker = null
        }
    }

    showMarkerPopup(markerId: number, content, _options)
    //==================================================
    {
        const marker = this.#activeMarker
        if (marker === null || markerId !== this.#markerIdByMarker.get(marker)) {
            this.#clearActiveMarker()
            return false
        }

        const location = marker.getLngLat()

        // Make sure the marker is on screen

        if (!this.#map.getBounds().contains(location)) {
            this.#map.panTo(location)
        }

        const element = document.createElement('div')
        if (typeof content === 'object') {
            element.appendChild(content)
        } else {
            element.innerHTML = content
        }

        element.addEventListener('click', _ => this.#clearActiveMarker())

        this.#tooltip = new maplibregl.Popup({
            closeButton: false,
            closeOnClick: false,
            maxWidth: 'none',
            className: 'flatmap-marker-popup'
        })

        this.#tooltip
            .setLngLat(location)
            .setDOMContent(element)

        // Set the marker tooltip and show it
        marker.setPopup(this.#tooltip)
        marker.togglePopup()

        return true
    }

    enablePanZoomEvents(enabled: boolean=true)
    //========================================
    {
        this.#pan_zoom_enabled = enabled
    }

    #panZoomEvent(type: string, event)
    //================================
    {
        if (this.#pan_zoom_enabled) {
            this.#flatmap.panZoomEvent(type)
        }
        if (type === 'zoom') {
            this.#layerManager.zoomEvent()
        }

        if (type === 'zoomend') {
            this.#featureZoomRangesBySourceLayer.clear()
            if (this.#lastMousePoint !== null) {
                if ('originalEvent' in event) {
                    if ('layerX' in event.originalEvent && 'layerY' in event.originalEvent) {
                        this.#updateActiveFeature([
                            event.originalEvent.layerX,
                            event.originalEvent.layerY
                        ])
                    }
                }
            }
        }

        if (type === 'zoomend' || type === 'moveend') {
            this.#updateAreaDensity()
        }
    }

    //==========================================================================

    addImage(anatomicalId, imageUrl, _options={})
    //===========================================
    {
        const featureIds = this.#flatmap.modelFeatureIds(anatomicalId)
        const imageIds: string[] = []
        const mapImageId = `image-${this.#lastImageId}`
        for (const featureId of featureIds) {
            const annotation = this.#flatmap.annotation(featureId)
            if (!(annotation
               && annotation.geometry
               && annotation.geometry.includes('Polygon'))) {
                continue
            }
            this.#lastImageId += 1
            const imageId = `${mapImageId}-${this.#lastImageId}`
            const featureBounds = annotation.bounds!
            this.#map.addSource(`${imageId}-source`, {
                type: 'image',
                url: imageUrl,
                coordinates: [
                    [featureBounds[0], featureBounds[3]],
                    [featureBounds[2], featureBounds[3]],
                    [featureBounds[2], featureBounds[1]],
                    [featureBounds[0], featureBounds[1]],
                ]
            })
            this.#map.addLayer({
                id: `${imageId}-layer`,
                'type': 'raster',
                'source': `${imageId}-source`,
                'paint': {
                    'raster-fade-duration': 0
                }
            })
            imageIds.push(imageId)
        }
        if (imageIds.length === 0) {
            console.warn(`Unable to find feature '${anatomicalId}' on which to place image`)
            return null
        }
        this.#imageLayerIds.set(mapImageId, imageIds)
        return mapImageId
    }

    removeImage(mapImageId: string)
    //=============================
    {
        if (this.#imageLayerIds.has(mapImageId)) {
            for (const imageId of this.#imageLayerIds.get(mapImageId)) {
                const layerId = `${imageId}-layer`
                if (this.#map.getLayer(layerId)) {
                    this.#map.removeLayer(layerId)
                }
                this.#map.removeSource(`${imageId}-source`)
            }
            this.#imageLayerIds.delete(mapImageId)
        }
    }

    //==========================================================================

    getNerveDetails(): NerveCentrelineDetails[]
    //=========================================
    {
        return this.#pathManager.nerveCentrelineDetails
    }

    enableNeuronPathsByNerve(nerveModels: string|string[], enable=true, showCentreline=false)
    //=======================================================================================
    {
        this.#nerveCentrelineFacet.enable(Array.isArray(nerveModels) ? nerveModels : [nerveModels], enable)
        this.#pathTypeFacet.enableCentrelines(showCentreline)
        this.#layerManager.refresh()
    }
}

//==============================================================================
