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
	    }
	}
	export class GenerationResult {
	    imageBase64: string;
	    seed: number;
	    source: string;
	    savedPath: string;
	
	    static createFrom(source: any = {}) {
	        return new GenerationResult(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.imageBase64 = source["imageBase64"];
	        this.seed = source["seed"];
	        this.source = source["source"];
	        this.savedPath = source["savedPath"];
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
	export class Settings {
	    apiKey: string;
	    pythonPath: string;
	    sdxlPath: string;
	    cloudModel: string;
	    outputDir: string;
	    paymentMode: string;
	    walletAddress: string;
	    localModel?: ModelInfo;
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

