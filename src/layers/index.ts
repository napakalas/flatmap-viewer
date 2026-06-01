/*==============================================================================

Flatmap viewer and annotation tool

Copyright (c) 2019 - 2024 David Brooks

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

import type {Map as MapLibreMap} from 'maplibre-gl'

//==============================================================================

import {PropertiesFilter, type StyleFilterType} from '../filters'
import {DetailsFilter} from '../filters/facets/details'
import type {FilteredFacet} from '../filters/facets'
import type {DatasetTerms, DatasetMarkerResult, FlatMapImageLayer, FlatMapLayer} from '../flatmap-types'
import type {FlatMapFeatureAnnotation, FlatMapMarkerOptions} from '../flatmap-types'
import type {GeoJSONId, MapExtent, MapFeature, MapRenderedFeature, MapPointFeature} from '../flatmap-types'
import {type FlatMap, FLATMAP_STYLE} from '../flatmap'
import {PATHWAYS_LAYER} from '../pathways'
import type {UserInteractions} from '../interactions'
import * as utils from '../utils'

import {ANATOMICAL_MARKERS_LAYER, ClusteredAnatomicalMarkerLayer} from './acluster'

import * as style from './styling'
import {BackgroundStyleLayer, BodyStyleLayer, RasterStyleLayer, type StylingOptions} from './styling'
import {type VectorStyleLayer, VECTOR_TILES_SOURCE} from './styling'

import {DeckGlOverlay} from './deckgl'
import {FlightPathLayer} from './flightpaths'
import {MarkerLayer} from './markers'
//import {SvgLayer} from './svglayer'

//==============================================================================

const FEATURES_LAYER = 'features'

const REVERT_DETAIL_ZOOM_OFFSET = 0.5
// const REVERT_DETAIL_ZOOM_RATIO = 0.95

//==============================================================================

export function isMarker(feature: MapFeature|MapRenderedFeature): boolean
{
    return (feature.properties.marker
         || 'layer' in feature && feature.layer.id === ANATOMICAL_MARKERS_LAYER)
}

//==============================================================================

class FlatMapStylingLayer
{
    #active: boolean = true
    #description: string
    #id: string
    #layer: FlatMapLayer
    #layerOptions: StylingOptions
    #map: MapLibreMap
    #markerLayer: MarkerLayer
    #markersByFeature: Map<number, number> = new Map()
    #minimapStylingLayers: maplibregl.LayerSpecification[] = []
    #pathsEnabled: boolean
    #pathStyleLayers: VectorStyleLayer[] = []
    #parentLayer: FlatMapStylingLayer|null = null
    #rasterStyleLayers: RasterStyleLayer[] = []
    #separateLayers: boolean
    #vectorStyleLayers: VectorStyleLayer[] = []

    constructor(flatmap: FlatMap, ui: UserInteractions, layer: FlatMapLayer, options: StylingOptions)
    {
        this.#id = layer.id
        this.#layer = layer
        this.#map = flatmap.map
        this.#description = layer.description || ''
        this.#layerOptions = options
        this.#separateLayers = flatmap.options.separateLayers
        this.#pathsEnabled = !flatmap.options.pathsDisabled

        // Make sure image layer information is in its expected format
        const imageLayers = flatmap.details['image-layers'] && (layer['image-layers'] || false)
            ? layer['image-layers'].map(imageLayer => {
                return (imageLayer instanceof Object)
                  ? imageLayer
                  : {
                        id: imageLayer,
                        options: {}
                    }
                })
            : []
        this.#layerOptions.hasImageLayers = (imageLayers.length > 0)

        // Originally only for body layer on AC maps but now also used
        // for detail background (FC and AC)
        const layerId = `${layer.id}_${FEATURES_LAYER}`
        const source = flatmap.options.separateLayers ? layerId : FEATURES_LAYER

        if (this.#map.getSource(style.VECTOR_TILES_SOURCE).vectorLayerIds.indexOf(source) >= 0) {
            const bodyLayer = new BodyStyleLayer(layerId, source)
            this.#addStylingLayer(bodyLayer.style(layer, this.#layerOptions), true)
            this.#vectorStyleLayers.push(bodyLayer)
            const borderLayer = new style.BackgroundBorderLayer(layerId, source)
            this.#addStylingLayer(borderLayer.style(layer, this.#layerOptions), true)
            this.#vectorStyleLayers.push(borderLayer)
        }

        // Image feature layers are generally below feature vector layers
        if (flatmap.details['image-layers']) {
            this.#layerOptions.activeRasterLayer = true
            // Except for a FUNCTIONAL map, which has connections underneath feature images
            // with possibly a background raster underneath the connections
            for (const imageLayer of imageLayers) {
                if (imageLayer.options.background || false) {
                    this.#addRasterLayer(imageLayer)
                    break
                }
            }
            if (options.flatmapStyle === FLATMAP_STYLE.FUNCTIONAL) {
                this.#addPathwayStyleLayers()
            }
            for (const imageLayer of imageLayers) {
                if (!(imageLayer.options.background || false)) {
                    this.#addRasterLayer(imageLayer)
                }
            }
        } else {
            this.#layerOptions.activeRasterLayer = false
            if (options.flatmapStyle === FLATMAP_STYLE.FUNCTIONAL) {
                this.#addPathwayStyleLayers()
            }
        }

        const vectorTileSource = this.#map.getSource(VECTOR_TILES_SOURCE)
        const haveVectorLayers = !!vectorTileSource

        if (haveVectorLayers) {
            const featuresVectorSource = this.#vectorSourceId(FEATURES_LAYER)
            const vectorFeatures = vectorTileSource.vectorLayerIds.includes(featuresVectorSource)
            if (vectorFeatures) {
                this.#addVectorStyleLayer(style.FeatureFillLayer, FEATURES_LAYER, false, true)
                this.#addVectorStyleLayer(style.FeatureDashLineLayer, FEATURES_LAYER, false, true)
                this.#addVectorStyleLayer(style.FeatureLineLayer, FEATURES_LAYER, false, true)
                this.#addVectorStyleLayer(style.FeatureBorderLayer, FEATURES_LAYER, false, true)
                this.#addVectorStyleLayer(style.CentrelineNodeFillLayer, FEATURES_LAYER)
            }
            if (options.flatmapStyle !== FLATMAP_STYLE.FUNCTIONAL) {
                this.#addPathwayStyleLayers()
            }
            if (vectorFeatures) {
                this.#addVectorStyleLayer(style.FeatureLargeSymbolLayer, FEATURES_LAYER)
                if (flatmap.options.hideTooltips) {
                    this.#addVectorStyleLayer(style.FeatureSmallSymbolLayer, FEATURES_LAYER)
                }
                if (options.flatmapStyle === FLATMAP_STYLE.FUNCTIONAL) {
                    this.#addVectorStyleLayer(style.FeatureZoomPointLayer, FEATURES_LAYER)
                }
                if (flatmap.mapMetadata['map-kinds']?.includes('model')) {
                    this.#addVectorStyleLayer(style.HighlightVariablesLayer, FEATURES_LAYER)
                }
            }
        }

        // The marker layer sits in front of all other layers
        this.#markerLayer = new MarkerLayer(flatmap, ui, layer.id)

        // Make sure our paint options are set properly, in particular raster layer visibility
        this.setPaint(this.#layerOptions)

        // Detail layers only show by clicking on their low-resolution feature or their zoom marker
        if (layer['detail-layer'] && flatmap.options.style!==FLATMAP_STYLE.ANATOMICAL) {
            this.activate(false)
        }
    }

    get active()
    //==========
    {
        return this.#active
    }

    get centre(): [number, number]
    //============================
    {
        const extent = this.#layer.extent
        return [(extent[0] + extent[2])/2, (extent[1] + extent[3])/2]
    }

    get description()
    //===============
    {
        return this.#description
    }

    get extent(): MapExtent
    //=====================
    {
        return this.#layer.extent
    }

    get id()
    //======
    {
        return this.#id
    }

    get layer()
    //=========
    {
        return this.#layer
    }

    get minimapStylingLayers()
    //========================
    {
        return this.#minimapStylingLayers
    }

    get minZoom(): number
    //===================
    {
        return this.#layer['min-zoom']
    }

    get parentLayer()
    //===============
    {
        return this.#parentLayer
    }

    setParent(parentLayer: FlatMapStylingLayer)
    //=========================================
    {
        this.#parentLayer = parentLayer
    }

    activate(enable=true)
    //===================
    {
        for (const styleLayer of this.#vectorStyleLayers) {
            this.#showStyleLayer(styleLayer.id, enable)
        }
        for (const styleLayer of this.#rasterStyleLayers) {
            this.#showStyleLayer(styleLayer.id, enable)
        }
        this.#showStyleLayer(this.#markerLayer.id, enable)
        // Deactivate/activate markers in our parent layer...
        if (this.parentLayer) {
            this.#showStyleLayer(this.parentLayer.#markerLayer.id, !enable)
        }

        this.#active = enable
        this.#setPaintRasterLayers(this.#layerOptions)
    }

    addLayeredMarker(annotation: FlatMapFeatureAnnotation, options: FlatMapMarkerOptions, cluster: boolean=false): GeoJSONId|null
    //===========================================================================================================================
    {
        const markerId = this.#markerLayer.addMarker(annotation, options, cluster)
        if (markerId !== null) {
            this.#markersByFeature.set(annotation.featureId, markerId)
        }
        return markerId
    }

    clearLayeredMarkers()
    //===================
    {
        this.#markerLayer.clearMarkers()
    }

    updateBaseMarker(baseFeature: FlatMapFeatureAnnotation, options: FlatMapMarkerOptions)
    //===================================================================================
    {
        const baseMarkerId = this.#markersByFeature.get(baseFeature.featureId)
        if (baseMarkerId) {
            this.#markerLayer.updateMarkerCount(baseMarkerId)
        } else {
            this.addLayeredMarker(baseFeature, options, true)
        }
    }

    #addPathwayStyleLayers()
    //======================
    {
        const pathwaysVectorSource = this.#vectorSourceId(PATHWAYS_LAYER)
        if (this.#pathsEnabled
         && this.#map.getSource('vector-tiles')
                .vectorLayerIds
                .includes(pathwaysVectorSource)) {
            this.#addVectorStyleLayer(style.AnnotatedPathLayer, PATHWAYS_LAYER, true, true)

            this.#addVectorStyleLayer(style.NerveCentrelineEdgeLayer, PATHWAYS_LAYER)
            this.#addVectorStyleLayer(style.NerveCentrelineTrackLayer, PATHWAYS_LAYER)

            this.#addVectorStyleLayer(style.PathLineLayer, PATHWAYS_LAYER, true, true)
            this.#addVectorStyleLayer(style.PathDashlineLayer, PATHWAYS_LAYER, true, true)

            this.#addVectorStyleLayer(style.NervePolygonBorder, PATHWAYS_LAYER, true)
            this.#addVectorStyleLayer(style.NervePolygonFill, PATHWAYS_LAYER, true)
            this.#addVectorStyleLayer(style.FeatureNerveLayer, PATHWAYS_LAYER, true)

            this.#addVectorStyleLayer(style.PathHighlightLayer, PATHWAYS_LAYER, true)
            this.#addVectorStyleLayer(style.PathDashHighlightLayer, PATHWAYS_LAYER, true)
        }
    }

    #addRasterLayer(layer: FlatMapImageLayer)
    //=======================================
    {
        const rasterLayer = new RasterStyleLayer(layer.id, layer.options)
        this.#addStylingLayer(rasterLayer.style(layer, this.#layerOptions), true)
        this.#rasterStyleLayers.push(rasterLayer)
    }

    #addStylingLayer(style: maplibregl.LayerSpecification, minimap=false)
    //===================================================================
    {
        this.#map.addLayer(style)
        if (minimap) {
            this.#minimapStylingLayers.push(style)
        }
    }

    #addVectorStyleLayer(vectorStyleClass, sourceLayer: string, pathLayer=false, minimap=false): VectorStyleLayer
    //===========================================================================================================
    {
        const vectorStyleLayer = new vectorStyleClass(`${this.#id}_${sourceLayer}`,
                                                      this.#vectorSourceId(sourceLayer))
        this.#addStylingLayer(vectorStyleLayer.style(this.#layer, this.#layerOptions), minimap)
        this.#vectorStyleLayers.push(vectorStyleLayer)
        if (pathLayer) {
            this.#pathStyleLayers.push(vectorStyleLayer)
        }
        return vectorStyleLayer
    }

    clearVisibilityFilter()
    //=====================
    {
        for (const layer of this.#vectorStyleLayers) {
            this.#map.setFilter(layer.id, layer.defaultFilter(), {validate: false})
        }
    }

    setFlatPathMode(visible: boolean)
    //===============================
    {
        for (const layer of this.#pathStyleLayers) {
            this.#map.setLayoutProperty(layer.id, 'visibility', visible ? 'visible' : 'none')
        }
    }

    setPaint(options: StylingOptions)
    //===============================
    {
        for (const layer of this.#vectorStyleLayers) {
            const paintStyle = layer.paintStyle(options, true)
            for (const [property, value] of Object.entries(paintStyle)) {
                this.#map.setPaintProperty(layer.id, property, value, {validate: false})
            }
        }
        this.#setPaintRasterLayers(options)
    }

    #setPaintRasterLayers(options)
    //============================
    {
        const coloured = !('coloured' in options) || options.coloured
        for (const layer of this.#rasterStyleLayers) {
            // Check active status when resetting to visible....
            this.#map.setLayoutProperty(layer.id, 'visibility',
                                                   (coloured && this.#active) ? 'visible' : 'none',
                                         {validate: false})
        }
    }

    setVisibilityFilter(filter: StyleFilterType)
    //==========================================
    {
        for (const layer of this.#vectorStyleLayers) {
            const styleFilter = layer.defaultFilter()
            let newFilter = null
            if (styleFilter) {
                if (styleFilter[0] === 'all') {
                    if (Array.isArray(filter) && filter[0] === 'all') {
                        newFilter = [...styleFilter, ...filter.slice(1)]
                    } else {
                        newFilter = [...styleFilter, filter]
                    }
                } else if (filter[0] === 'all') {
                    newFilter = [...filter, styleFilter]
                } else {
                    newFilter = [filter, styleFilter]
                }
            } else {
                newFilter = filter
            }
            if (newFilter) {
                this.#map.setFilter(layer.id, newFilter, {validate: true})
            }
        }
    }

    dimRasterLayers(dimmed: boolean=true)
    //===================================
    {
        for (const rasterLayer of this.#rasterStyleLayers) {
            this.#map.setPaintProperty(rasterLayer.id, 'raster-opacity', dimmed ? 0.2 : 1.0)
        }
    }

    #showStyleLayer(styleLayerId: string, visible=true)
    //=================================================
    {
        this.#map.setLayoutProperty(styleLayerId, 'visibility', visible ? 'visible' : 'none')
    }

    #vectorSourceId(sourceLayer: string)
    //==================================
    {
        return (this.#separateLayers ? `${this.#id}_${sourceLayer}`
                                      : sourceLayer).replaceAll('/', '_')
    }
}

//==============================================================================

export class LayerManager
{
    #baseLayer: FlatMapStylingLayer|null = null
    #currentDetailLayer: FlatMapStylingLayer|null = null
    #deckGlOverlay: DeckGlOverlay
    #detailsFilter: DetailsFilter|null = null
    #facetMap: Map<string, FilteredFacet> = new Map()
    #filterMap: Map<string, PropertiesFilter> = new Map()
    #flatmap: FlatMap
    #flightPathLayer: FlightPathLayer
    #layerOptions: StylingOptions
    #map: MapLibreMap
    #mapStyleLayers: Map<string, FlatMapStylingLayer> = new Map()
    #clusteredAnatomicalMarkerLayer: ClusteredAnatomicalMarkerLayer
    #minimapStyleSpecification: maplibregl.StyleSpecification
//    #modelLayer
    #revertDetailZoom: number = -1

    constructor(flatmap: FlatMap, ui: UserInteractions)
    {
        this.#flatmap = flatmap
        this.#map = flatmap.map
        this.#layerOptions = utils.setDefaults(flatmap.options.layerOptions, {
            coloured: true,
            flatmapStyle: flatmap.options.style,
            outlined: true,
            sckan: 'valid'
        })
        this.#minimapStyleSpecification = this.#map.getStyle()

        const backgroundLayer = new BackgroundStyleLayer()
        const backgroundLayerStyle = backgroundLayer.style(null, {
            colour: flatmap.options.background || 'white'
        }) as maplibregl.LayerSpecification
        this.#map.addLayer(backgroundLayerStyle)
        this.#minimapStyleSpecification.layers.push(backgroundLayerStyle)

        // Add the map's layers
        for (const layer of flatmap.layers) {
            const flatmapStylingLayer = new FlatMapStylingLayer(this.#flatmap, ui,
                                                                layer,
                                                                this.#layerOptions)
            this.#mapStyleLayers.set(layer.id, flatmapStylingLayer)
            this.#minimapStyleSpecification.layers.push(...flatmapStylingLayer.minimapStylingLayers)
        }
        for (const layer of this.#mapStyleLayers.values()) {
            const parentLayer = this.#mapStyleLayers.get(layer.layer['parent-layer'])
            if (parentLayer) {
                layer.setParent(parentLayer)
            }
        }

        // Show anatomical clustered markers in a layer
        this.#clusteredAnatomicalMarkerLayer = new ClusteredAnatomicalMarkerLayer(flatmap, ui)

        // We use ``deck.gl`` for some layers
        this.#deckGlOverlay = new DeckGlOverlay(flatmap)

        // Support flight path view
        this.#flightPathLayer = new FlightPathLayer(this.#deckGlOverlay, flatmap, ui)

        // Simulation models are in SVG
//        this.#modelLayer = new SvgLayer(this.#deckGlOverlay, flatmap)
    }

    get layers(): FlatMapLayer[]
    //==========================
    {
        const layers: FlatMapLayer[] = []
        for (const mapLayer of this.#mapStyleLayers.values()) {
            layers.push({
                id: mapLayer.id,
                description: mapLayer.description,
                enabled: mapLayer.active
            })
        }
        return layers
    }

    get minimapStyleSpecification()
    //=============================
    {
        return this.#minimapStyleSpecification
    }

    get sckanState()
    //==============
    {
        return this.#layerOptions.sckan
    }

    activate(layerId: string, enable=true)
    //====================================
    {
        const layer = this.#mapStyleLayers.get(layerId)
        if (layer) {
            layer.activate(enable)
        }
    }

    addMarker(_id, _position, _properties={})
    //=======================================
    {
    // Geographical clustering
        //this.#markerLayer.addMarker(id, position, properties)
    }

    clearMarkers()
    //============
    {
    // Geographical clustering
        //this.#markerLayer.clearMarkers()
    }

    addClusteredAnatomicalMarkers(datasets: DatasetTerms[]): DatasetTerms[]
    //=====================================================================
    {
        return this.#clusteredAnatomicalMarkerLayer.addClusteredMarkers(datasets)
    }

    addLayeredMarker(annotation: FlatMapFeatureAnnotation, options: FlatMapMarkerOptions): GeoJSONId|null
    //===================================================================================================
    {
        const stylingLayer = this.#mapStyleLayers.get(annotation.layer)
        if (stylingLayer) {
            const baseFeature = this.#flatmap.annotation(stylingLayer.layer['zoom-point'])
            if (stylingLayer.parentLayer && baseFeature) {
                stylingLayer.parentLayer.updateBaseMarker(baseFeature, options)
            }
            return stylingLayer.addLayeredMarker(annotation, options)
        }
        return null
    }

    clearClusteredAnatomicalMarkers()
    //===============================
    {
        this.#clusteredAnatomicalMarkerLayer.clearClusteredMarkers()
    }

    clearLayeredMarkers()
    //===================
    {
        for (const styleLayer of this.#mapStyleLayers.values()) {
            styleLayer.clearLayeredMarkers()
        }
    }

    datasetTerms(term: string): DatasetMarkerResult[]
    //===============================================
    {
        return this.#clusteredAnatomicalMarkerLayer.datasetTerms(term)
    }

    removeClusteredAnatomicalMarker(datasetId: string)
    //================================================
    {
        this.#clusteredAnatomicalMarkerLayer.removeClusteredMarker(datasetId)
    }

    featuresAtPoint(point): MapPointFeature[]
    //=======================================
    {
        let features: MapPointFeature[] = []
        features = this.#flightPathLayer.queryFeaturesAtPoint(point)
        if (features.length === 0) {
            features = this.#map.queryRenderedFeatures(point, {layers: [ANATOMICAL_MARKERS_LAYER]})
        }
        if (features.length === 0) {
            features = this.#map.queryRenderedFeatures(point)
        }
        return features
    }

    removeFeatureState(featureId: GeoJSONId, key: string)
    //===================================================
    {
        this.#flightPathLayer.removeFeatureState(featureId, key)
        this.#clusteredAnatomicalMarkerLayer.removeFeatureState(featureId, key)
    }

    setFeatureState(featureId: GeoJSONId, state)
    //==========================================
    {
        this.#flightPathLayer.setFeatureState(featureId, state)
        this.#clusteredAnatomicalMarkerLayer.setFeatureState(featureId, state)
    }

    setPaint(options={})
    //==================
    {
        this.#layerOptions = utils.setDefaults(options, this.#layerOptions)
        for (const mapLayer of this.#mapStyleLayers.values()) {
            mapLayer.setPaint(this.#layerOptions)
        }
        this.#flightPathLayer.setPaint(options)
    }

    addFilteredFacet(facet: FilteredFacet)
    //====================================
    {
        this.#facetMap.set(facet.id, facet)
        this.#filterMap.set(facet.id, facet.makeFilter())
        this.#updatedFilters()
    }

    removeFilteredFacet(id: string)
    //=============================
    {
        if (this.#facetMap.has(id)) {
            this.#facetMap.delete(id)
            this.#filterMap.delete(id)
            this.#updatedFilters()
        }
    }

    refresh()
    //=======
    {
        for (const facet of this.#facetMap.values()) {
            this.#filterMap.set(facet.id, facet.makeFilter())
        }
        this.#updatedFilters()
    }

    clearVisibilityFilter()
    //=====================
    {
        this.#filterMap.delete('')
        this.#updatedFilters()
    }

    setVisibilityFilter(propertiesFilter: PropertiesFilter)
    //=====================================================
    {
        this.#filterMap.set('', propertiesFilter)
        this.#updatedFilters()
    }

    setFlightPathMode(enable=true)
    //============================
    {
        this.#flightPathLayer.enable(enable)
        for (const mapLayer of this.#mapStyleLayers.values()) {
            mapLayer.setFlatPathMode(!enable)
        }
    }

    #updatedFilters()
    //===============
    {
        if (this.#filterMap.size > 0) {
            const propertiesFilter = new PropertiesFilter({
                'AND': [...this.#filterMap.values()].map(f => f.filter)
            })
            const styleFilter = propertiesFilter.getStyleFilter()
            for (const mapLayer of this.#mapStyleLayers.values()) {
                mapLayer.setVisibilityFilter(styleFilter)
            }
            this.#flightPathLayer.setVisibilityFilter(propertiesFilter)
        } else {
            for (const mapLayer of this.#mapStyleLayers.values()) {
                mapLayer.clearVisibilityFilter()
            }
            this.#flightPathLayer.clearVisibilityFilter()
        }
    }

    zoomEvent()
    //=========
    {
        const zoomLevel = this.#map.getZoom()
        if (this.#currentDetailLayer && zoomLevel < this.#revertDetailZoom) {
            this.#currentDetailLayer.activate(false)
            if (this.#detailsFilter) {
                this.removeFilteredFacet(this.#detailsFilter.id)
                this.#detailsFilter = null
            }
             if (this.#baseLayer) {
                this.#baseLayer.dimRasterLayers(false)
            }
            this.#currentDetailLayer = null
            this.#revertDetailZoom = -1
        }
    }

    enableDetailedLayer(currentLayerId: string, layerId: string)
    //==========================================================
    {
        if (this.#baseLayer === null) {
            this.#baseLayer = this.#mapStyleLayers.get(currentLayerId)
        }
        const detailLayer = this.#mapStyleLayers.get(layerId)
        if (detailLayer) {
            this.#baseLayer.dimRasterLayers()
            if (this.#detailsFilter) {
                this.removeFilteredFacet(this.#detailsFilter.id)
            }
            this.#detailsFilter = new DetailsFilter(layerId)
            this.addFilteredFacet(this.#detailsFilter)
            detailLayer.activate(true)
            this.#currentDetailLayer = detailLayer
            this.#map.fitBounds(detailLayer.extent, {
                animate: false,
                padding: 50
            })
            this.#revertDetailZoom = this.#map.getZoom() - REVERT_DETAIL_ZOOM_OFFSET
        }
    }

    freeDeckGLResource()
    //==================
    {
        if (this.#deckGlOverlay) {
            this.#deckGlOverlay.finalise()
        }
    }

    enableSckanPaths(_sckanState, _enable=true)
    //=======================================
    {
/** WIP
        const currentState = this.#layerOptions.sckan
        const validEnabled = ['valid', 'all'].includes(currentState)
        const invalidEnabled = ['invalid', 'all'].includes(currentState)
        let newState = sckanState.toLowerCase()
        if (newState === 'valid') {
            if (enable && !validEnabled) {
                newState = invalidEnabled ? 'all' : 'valid'
            } else if (!enable && validEnabled) {
                newState = invalidEnabled ? 'invalid' : 'none'
            }
        } else if (newState === 'invalid') {
            if (enable && !invalidEnabled) {
                newState = validEnabled ? 'all' : 'invalid'
            } else if (!enable && invalidEnabled) {
                newState = validEnabled ? 'valid' : 'none'
            }
        }
        if (newState !== this.#layerOptions.sckan) {
            this.setFilter({sckan: newState})
        }

        const sckanState = options.sckan || 'valid'
        const sckanFilter = (sckanState == 'none') ? {NOT: {HAS: 'sckan'}} :
                            (sckanState == 'valid') ? {sckan: true} :
                            (sckanState == 'invalid') ? {NOT: {sckan: true}} :
                            true
        const featureFilter = new PropertiesFilter(sckanFilter)
        if ('taxons' in options) {
            featureFilter.narrow({taxons: options.taxons})
        }

    const sckanState = !'sckan' in options ? 'all'
                     : options.sckan.toLowerCase()
    const sckanFilter =
        sckanState == 'none' ? [
            ['!', ['has', 'sckan']]
        ] :
        sckanState == 'valid' ? [[
            'any',
            ['!', ['has', 'sckan']],
            [
                'all',
                ['has', 'sckan'],
                ['==', ['get', 'sckan'], true]
            ]
        ]] :
        sckanState == 'invalid' ? [[
            'any',
            ['!', ['has', 'sckan']],
            [
                'all',
                ['has', 'sckan'],
                ['!=', ['get', 'sckan'], true]
            ]
        ]] :
        [ ]
**/

    }
}

//==============================================================================
