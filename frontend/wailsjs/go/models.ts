export namespace logbus {
	
	export class Entry {
	    id: number;
	    timestamp: string;
	    level: string;
	    source: string;
	    message: string;
	    data?: any;
	
	    static createFrom(source: any = {}) {
	        return new Entry(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.timestamp = source["timestamp"];
	        this.level = source["level"];
	        this.source = source["source"];
	        this.message = source["message"];
	        this.data = source["data"];
	    }
	}

}

export namespace types {
	
	export class CreditInfo {
	    configured: boolean;
	    credits: number;
	    error?: string;
	
	    static createFrom(source: any = {}) {
	        return new CreditInfo(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.configured = source["configured"];
	        this.credits = source["credits"];
	        this.error = source["error"];
	    }
	}
	export class EngineInfo {
	    installed: boolean;
	    venvDir: string;
	    pythonPath: string;
	
	    static createFrom(source: any = {}) {
	        return new EngineInfo(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.installed = source["installed"];
	        this.venvDir = source["venvDir"];
	        this.pythonPath = source["pythonPath"];
	    }
	}
	export class WanRuntimeSettings {
	    device?: string;
	    memoryProfile?: string;
	    textEncoderQuant?: string;
	    vaeTiling?: boolean;
	    enableOffload?: boolean;
	    maxResident?: string;
	
	    static createFrom(source: any = {}) {
	        return new WanRuntimeSettings(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.device = source["device"];
	        this.memoryProfile = source["memoryProfile"];
	        this.textEncoderQuant = source["textEncoderQuant"];
	        this.vaeTiling = source["vaeTiling"];
	        this.enableOffload = source["enableOffload"];
	        this.maxResident = source["maxResident"];
	    }
	}
	export class ZImageRuntimeSettings {
	    device?: string;
	    enableCpuOffload?: boolean;
	    maxGpuModels?: string;
	    maxCpuModels?: string;
	
	    static createFrom(source: any = {}) {
	        return new ZImageRuntimeSettings(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.device = source["device"];
	        this.enableCpuOffload = source["enableCpuOffload"];
	        this.maxGpuModels = source["maxGpuModels"];
	        this.maxCpuModels = source["maxCpuModels"];
	    }
	}
	export class ImageRuntimeSettings {
	    device?: string;
	    useTinyVae?: boolean;
	    enableCpuOffload?: boolean;
	    maxGpuModels?: string;
	    maxCpuModels?: string;
	
	    static createFrom(source: any = {}) {
	        return new ImageRuntimeSettings(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.device = source["device"];
	        this.useTinyVae = source["useTinyVae"];
	        this.enableCpuOffload = source["enableCpuOffload"];
	        this.maxGpuModels = source["maxGpuModels"];
	        this.maxCpuModels = source["maxCpuModels"];
	    }
	}
	export class EngineRuntimeSettings {
	    sdxl: ImageRuntimeSettings;
	    zimage: ZImageRuntimeSettings;
	    wan: WanRuntimeSettings;
	
	    static createFrom(source: any = {}) {
	        return new EngineRuntimeSettings(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.sdxl = this.convertValues(source["sdxl"], ImageRuntimeSettings);
	        this.zimage = this.convertValues(source["zimage"], ZImageRuntimeSettings);
	        this.wan = this.convertValues(source["wan"], WanRuntimeSettings);
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class Facet {
	    value: string;
	    label: string;
	    count: number;
	
	    static createFrom(source: any = {}) {
	        return new Facet(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.value = source["value"];
	        this.label = source["label"];
	        this.count = source["count"];
	    }
	}
	export class FormatOption {
	    formatCode: string;
	    name?: string;
	    width: number;
	    height: number;
	    ratio?: string;
	    isDefault: boolean;
	
	    static createFrom(source: any = {}) {
	        return new FormatOption(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.formatCode = source["formatCode"];
	        this.name = source["name"];
	        this.width = source["width"];
	        this.height = source["height"];
	        this.ratio = source["ratio"];
	        this.isDefault = source["isDefault"];
	    }
	}
	export class GalleryFacets {
	    models: Facet[];
	    engines: Facet[];
	    sources: Facet[];
	
	    static createFrom(source: any = {}) {
	        return new GalleryFacets(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.models = this.convertValues(source["models"], Facet);
	        this.engines = this.convertValues(source["engines"], Facet);
	        this.sources = this.convertValues(source["sources"], Facet);
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class GalleryFilter {
	    engine: string;
	    modelCode: string;
	    source: string;
	
	    static createFrom(source: any = {}) {
	        return new GalleryFilter(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.engine = source["engine"];
	        this.modelCode = source["modelCode"];
	        this.source = source["source"];
	    }
	}
	export class GenerationMeta {
	    prompt: string;
	    negativePrompt?: string;
	    source: string;
	    modelCode?: string;
	    modelName?: string;
	    engine?: string;
	    width?: number;
	    height?: number;
	    formatCode?: string;
	    numSteps?: number;
	    guidanceScale?: number;
	    scheduler?: string;
	    clipSkip?: number;
	    seed: number;
	    img2img?: boolean;
	    strength?: number;
	    createdAt: string;
	
	    static createFrom(source: any = {}) {
	        return new GenerationMeta(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.prompt = source["prompt"];
	        this.negativePrompt = source["negativePrompt"];
	        this.source = source["source"];
	        this.modelCode = source["modelCode"];
	        this.modelName = source["modelName"];
	        this.engine = source["engine"];
	        this.width = source["width"];
	        this.height = source["height"];
	        this.formatCode = source["formatCode"];
	        this.numSteps = source["numSteps"];
	        this.guidanceScale = source["guidanceScale"];
	        this.scheduler = source["scheduler"];
	        this.clipSkip = source["clipSkip"];
	        this.seed = source["seed"];
	        this.img2img = source["img2img"];
	        this.strength = source["strength"];
	        this.createdAt = source["createdAt"];
	    }
	}
	export class GenerationRequest {
	    prompt: string;
	    negativePrompt?: string;
	    width: number;
	    height: number;
	    numSteps: number;
	    guidanceScale: number;
	    seed?: number;
	    scheduler?: string;
	    clipSkip?: number;
	    sourceImage?: string;
	    strength?: number;
	
	    static createFrom(source: any = {}) {
	        return new GenerationRequest(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.prompt = source["prompt"];
	        this.negativePrompt = source["negativePrompt"];
	        this.width = source["width"];
	        this.height = source["height"];
	        this.numSteps = source["numSteps"];
	        this.guidanceScale = source["guidanceScale"];
	        this.seed = source["seed"];
	        this.scheduler = source["scheduler"];
	        this.clipSkip = source["clipSkip"];
	        this.sourceImage = source["sourceImage"];
	        this.strength = source["strength"];
	    }
	}
	export class GenerationResult {
	    imageBase64: string;
	    seed: number;
	    source: string;
	    savedPath: string;
	    meta?: GenerationMeta;
	
	    static createFrom(source: any = {}) {
	        return new GenerationResult(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.imageBase64 = source["imageBase64"];
	        this.seed = source["seed"];
	        this.source = source["source"];
	        this.savedPath = source["savedPath"];
	        this.meta = this.convertValues(source["meta"], GenerationMeta);
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	
	export class ModelInfo {
	    modelCode: string;
	    name: string;
	    shortDescription: string;
	    mediumDescription: string;
	    image: string;
	    modelUrl: string;
	    promptPre: string;
	    promptNegative: string;
	    stepsDefault: number;
	    stepsMin: number;
	    stepsMax: number;
	    cfgDefault: number;
	    cfgMin: number;
	    cfgMax: number;
	    skipDefault: number;
	    schedulerDefault: string;
	    formatCode: string;
	    backendType?: string;
	    baseModel?: string;
	    shiftDefault?: number;
	    cost: number;
	    canLocal: boolean;
	    canCloud: boolean;
	    formats?: FormatOption[];
	    order?: number;
	    familyCode?: string;
	    familyName?: string;
	    groupCode?: string;
	
	    static createFrom(source: any = {}) {
	        return new ModelInfo(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.modelCode = source["modelCode"];
	        this.name = source["name"];
	        this.shortDescription = source["shortDescription"];
	        this.mediumDescription = source["mediumDescription"];
	        this.image = source["image"];
	        this.modelUrl = source["modelUrl"];
	        this.promptPre = source["promptPre"];
	        this.promptNegative = source["promptNegative"];
	        this.stepsDefault = source["stepsDefault"];
	        this.stepsMin = source["stepsMin"];
	        this.stepsMax = source["stepsMax"];
	        this.cfgDefault = source["cfgDefault"];
	        this.cfgMin = source["cfgMin"];
	        this.cfgMax = source["cfgMax"];
	        this.skipDefault = source["skipDefault"];
	        this.schedulerDefault = source["schedulerDefault"];
	        this.formatCode = source["formatCode"];
	        this.backendType = source["backendType"];
	        this.baseModel = source["baseModel"];
	        this.shiftDefault = source["shiftDefault"];
	        this.cost = source["cost"];
	        this.canLocal = source["canLocal"];
	        this.canCloud = source["canCloud"];
	        this.formats = this.convertValues(source["formats"], FormatOption);
	        this.order = source["order"];
	        this.familyCode = source["familyCode"];
	        this.familyName = source["familyName"];
	        this.groupCode = source["groupCode"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class PythonInfo {
	    path: string;
	    version: string;
	
	    static createFrom(source: any = {}) {
	        return new PythonInfo(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.path = source["path"];
	        this.version = source["version"];
	    }
	}
	export class SavedImage {
	    name: string;
	    source: string;
	    seed: number;
	    savedPath: string;
	    width: number;
	    height: number;
	    meta?: GenerationMeta;
	
	    static createFrom(source: any = {}) {
	        return new SavedImage(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.name = source["name"];
	        this.source = source["source"];
	        this.seed = source["seed"];
	        this.savedPath = source["savedPath"];
	        this.width = source["width"];
	        this.height = source["height"];
	        this.meta = this.convertValues(source["meta"], GenerationMeta);
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class Settings {
	    apiKey: string;
	    pythonPath: string;
	    sdxlPath: string;
	    cloudModel: string;
	    outputDir: string;
	    paymentMode: string;
	    walletAddress: string;
	    localModel?: ModelInfo;
	    engineRuntime: EngineRuntimeSettings;
	    cloudModelInfo?: ModelInfo;
	
	    static createFrom(source: any = {}) {
	        return new Settings(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.apiKey = source["apiKey"];
	        this.pythonPath = source["pythonPath"];
	        this.sdxlPath = source["sdxlPath"];
	        this.cloudModel = source["cloudModel"];
	        this.outputDir = source["outputDir"];
	        this.paymentMode = source["paymentMode"];
	        this.walletAddress = source["walletAddress"];
	        this.localModel = this.convertValues(source["localModel"], ModelInfo);
	        this.engineRuntime = this.convertValues(source["engineRuntime"], EngineRuntimeSettings);
	        this.cloudModelInfo = this.convertValues(source["cloudModelInfo"], ModelInfo);
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class SidecarStatus {
	    state: string;
	    port?: number;
	    device?: string;
	    message?: string;
	
	    static createFrom(source: any = {}) {
	        return new SidecarStatus(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.state = source["state"];
	        this.port = source["port"];
	        this.device = source["device"];
	        this.message = source["message"];
	    }
	}
	export class WalletInfo {
	    configured: boolean;
	    address: string;
	    balanceUSDC: string;
	    network: string;
	    error?: string;
	
	    static createFrom(source: any = {}) {
	        return new WalletInfo(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.configured = source["configured"];
	        this.address = source["address"];
	        this.balanceUSDC = source["balanceUSDC"];
	        this.network = source["network"];
	        this.error = source["error"];
	    }
	}
	

}

