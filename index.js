const { BrowserWindow, app, ipcMain, dialog } = require("electron");
const path = require("path");
require("@electron/remote/main").initialize();

const os = require("os");
const platform = os.platform();
const arch = os.arch();

var win;
function createWindow() {
	win = new BrowserWindow({
		width: 1200,
		height: 810,
		minWidth: 960,
		minHeight: 600,
		webPreferences: {
			nodeIntegration: true,
			contextIsolation: false,
			enableRemoteModule: true,
			devTools: false
		},
		titleBarStyle: "hidden",
		icon: platform == "darwin" ? path.join(__dirname, "icon", "mac", "icon.icns") : path.join(__dirname, "icon", "png", "128x128.png")
	});
	require("@electron/remote/main").enable(win.webContents);

	win.loadFile(path.resolve(__dirname, "src", "index.html"));

	win.setMenu(null);
	// win.webContents.openDevTools();
}

app.on("second-instance", () => {
	if (win) {
		if (win.isMinimized()) win.restore();
		win.focus();
	}
});

app.on("ready", () => {
	createWindow();
});

app.on("window-all-closed", () => {
	app.quit();
});
app.on("activate", () => {
	if (win == null) createWindow();
});
app.on("before-quit", () => {
	if (runningShell) runningShell.kill();
});

// OS STATS

const osUtil = require("os-utils");
var threads;
var sysThreads = osUtil.cpuCount();
for (let i = 1; i < sysThreads; i = i * 2) {
	threads = i;
}
if (sysThreads == 4) {
	threads = 4;
}
ipcMain.on("cpuUsage", () => {
	osUtil.cpuUsage(function (v) {
		win.webContents.send("cpuUsage", { data: v });
	});
});
ipcMain.on("cpuFree", () => {
	osUtil.cpuFree(function (v) {
		win.webContents.send("cpuFree", { data: v });
	});
});

ipcMain.on("cpuCount", () => {
	win.webContents.send("cpuCount", {
		data: osUtil.cpuCount()
	});
});
ipcMain.on("threadUtilized", () => {
	win.webContents.send("threadUtilized", {
		data: threads
	});
});
ipcMain.on("freemem", () => {
	win.webContents.send("freemem", {
		data: Math.round(osUtil.freemem() / 102.4) / 10
	});
});
ipcMain.on("totalmem", () => {
	win.webContents.send("totalmem", {
		data: osUtil.totalmem()
	});
});
ipcMain.on("os", () => {
	win.webContents.send("os", {
		data: platform
	});
});

// SET-UP
const Store = require("electron-store");
const schema = {
	params: {
		default: {
			model_type: "alpaca",
			repeat_last_n: "64",
			repeat_penalty: "1.3",
			top_k: "40",
			top_p: "0.9",
			temp: "0.8",
			seed: "-1",
			webAccess: false,
			websearch_amount: "5"
		}
	},
	modelPath: {
		default: "undefined"
	},
	supportsAVX2: {
		default: "undefined"
	},
	lastTranscriptionJob: {
		default: "undefined"
	}
};
const store = new Store({ schema });
const fs = require("fs");
var modelPath = store.get("modelPath");

function checkModelPath() {
	modelPath = store.get("modelPath");
	if (modelPath) {
		if (fs.existsSync(path.resolve(modelPath))) {
			win.webContents.send("modelPathValid", { data: true });
		} else {
			win.webContents.send("modelPathValid", { data: false });
		}
	} else {
		win.webContents.send("modelPathValid", { data: false });
	}
}
ipcMain.on("checkModelPath", checkModelPath);

ipcMain.on("checkPath", (_event, { data }) => {
	if (data) {
		if (fs.existsSync(path.resolve(data))) {
			store.set("modelPath", data);
			modelPath = store.get("modelPath");
			win.webContents.send("pathIsValid", { data: true });
		} else {
			win.webContents.send("pathIsValid", { data: false });
		}
	} else {
		win.webContents.send("pathIsValid", { data: false });
	}
});

ipcMain.on("checkAudioPath", (_event, { data }) => {
	if (data) {
		if (fs.existsSync(path.resolve(data))) {
			win.webContents.send("audiopathIsValid", { data: true });
		} else {
			win.webContents.send("audiopathIsValid", { data: false });
		}
	} else {
		win.webContents.send("audiopathIsValid", { data: false });
	}
});

// Import needed AWS libraries
const { S3Client, GetObjectCommand, PutObjectCommand } = require("@aws-sdk/client-s3");
const { Transcribe: TranscribeService } = require("@aws-sdk/client-transcribe");


// Create an S3Client object
const s3 = new S3Client();

// Create a TrascribeServive object
const transcribeService = new TranscribeService();

// Define your S3 bucket names where the audio files and output transcriptions are stored
const sourceBucketName = 'js-audio-files';
const targetBucketName = 'js-aws-transcribe-outputs';

ipcMain.on("processAudioFile", (_event, { data }) => {
	console.log(data)

	// Define the absolute file path of the MP3 file to upload
	const absoluteFilePath = data; // Replace with your file path

	// Extract the key (file name) from the absolute file path
	const key = path.basename(absoluteFilePath);

	// Read the MP3 file
	const fileContent = fs.readFileSync(absoluteFilePath);

	uploadFileAndSubmitTranscriptJob(sourceBucketName, key, fileContent);
});

// Function to upload the MP3 file to the source S3 bucket
function uploadFileAndSubmitTranscriptJob(bucket, key, content) {

	// Upload the MP3 file to the source S3 bucket
	s3.send(
		new PutObjectCommand(
			{
				Bucket: bucket,
				Key: key,
				Body: content,
			}),
		(err, data) => {
			if (err) {
				console.error('Error uploading MP3 file:', err);
			} else {
				console.log('MP3 file uploaded successfully:', data);
				const sourceUri = `s3://${sourceBucketName}/${key}`;
				const timestamp = Date.now();
				const transcriptionJobName = `${key}-transcription-job-${timestamp}`;
				submitTranscriptionJob(transcriptionJobName, sourceUri);
			}
		});
}


// Function to submit the transcription job
function submitTranscriptionJob(transcriptionJobName, sourceUri) {

	const params = {
		TranscriptionJobName: transcriptionJobName,
		LanguageCode: 'en-US', // Adjust language code as needed
		Media: { MediaFileUri: sourceUri },
		OutputBucketName: targetBucketName,
	};

	// Start the transcription job
	transcribeService.startTranscriptionJob(params, (err, data) => {
		if (err) {
			console.error('Error starting transcription job:', err);
		} else {
			console.log('Transcription job started successfully:', data);
			store.set("lastTranscriptionJob", transcriptionJobName);
		}
	});
}

ipcMain.on("checkTranscriptionJob", () => {
	jobName = store.get("lastTranscriptionJob");
	transcribeService.getTranscriptionJob({ TranscriptionJobName: jobName }, async (err, data) => {
		if (err) {
			console.error('Error getting transcription job status:', err);
		} else {
			const { TranscriptionJobStatus, TranscriptionJobName, Transcript } = data.TranscriptionJob;

			if (TranscriptionJobStatus === 'COMPLETED') {
				console.log(`Transcription job ${TranscriptionJobName} completed.`);
				const transcriptFileUri = Transcript.TranscriptFileUri;
				const transcriptBucket = transcriptFileUri.split('/')[3];
				const transcriptKey = transcriptFileUri.split('/').slice(4).join('/');

				const streamToString = (stream) =>
					new Promise((resolve, reject) => {
						const chunks = [];
						stream.on("data", (chunk) => chunks.push(chunk));
						stream.on("error", reject);
						stream.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
					});

				const { Body } = await s3.send(
					new GetObjectCommand(
						{
							Bucket: transcriptBucket,
							Key: transcriptKey
						})
				);

				const bodyContents = await streamToString(Body);
				transcr = JSON.parse(bodyContents).results.transcripts[0].transcript.toString()
				win.webContents.send("transcriptionJobStatus", { data: transcr });

			} else if (TranscriptionJobStatus === 'IN_PROGRESS') {
				console.log(`Transcription job ${TranscriptionJobName} is still in progress`);
				win.webContents.send("transcriptionJobStatus", {
					data: "in_progress"
				});
			} else if (TranscriptionJobStatus === 'FAILED' || TranscriptionJobStatus === 'CANCELED') {
				console.error(`Transcription job ${TranscriptionJobName} failed or was canceled.`);
				win.webContents.send("transcriptionJobStatus", {
					data: "failed_canceled"
				});
			}
		}
	});
});


// DUCKDUCKGO SEARCH FUNCTION
const DDG = require("duck-duck-scrape");
async function queryToPrompt(text) {
	const searchResults = await DDG.search(text, {
		safeSearch: DDG.SafeSearchType.MODERATE
	});
	if (!searchResults.noResults) {
		var convertedText = `Using the given web search results, answer the following query: `;
		convertedText += text;
		convertedText += "\\n### INPUT: \\n";
		convertedText += "Here are the web search results: ";
		var targetResultCount = store.get("params").websearch_amount || 5;
		if (searchResults.news) {
			for (let i = 0; i < searchResults.news.length && i < targetResultCount; i++) {
				convertedText += `${searchResults.news[i].description.replaceAll(/<\/?b>/gi, "")} `;
			}
		} else {
			for (let i = 0; i < searchResults.results.length && i < targetResultCount; i++) {
				convertedText += `${searchResults.results[i].description.replaceAll(/<\/?b>/gi, "")} `;
			}
		}
		return convertedText;
		// var convertedText = `Summarize the following text: `;
		// for (let i = 0; i < searchResults.results.length && i < 3; i++) {
		// 	convertedText += `${searchResults.results[i].description.replaceAll(/<\/?b>/gi, "")} `;
		// }
		// return convertedText;
	} else {
		return text;
	}
}

// RUNNING CHAT
const pty = require("node-pty-prebuilt-multiarch");
var runningShell, currentPrompt;
var alpacaReady,
	alpacaHalfReady = false;
var checkAVX,
	isAVX2 = false;
if (store.get("supportsAVX2") == undefined) {
	store.set("supportsAVX2", true);
}
var supportsAVX2 = store.get("supportsAVX2");
const config = {
	name: "xterm-color",
	cols: 69420,
	rows: 30
};

const shell = platform === "win32" ? "powershell.exe" : "bash";
const stripAnsi = (str) => {
	const pattern = ["[\\u001B\\u009B][[\\]()#;?]*(?:(?:(?:(?:;[-a-zA-Z\\d\\/#&.:=?%@~_]+)*|[a-zA-Z\\d]+(?:;[-a-zA-Z\\d\\/#&.:=?%@~_]*)*)?\\u0007)", "(?:(?:\\d{1,4}(?:;\\d{0,4})*)?[\\dA-PR-TZcf-nq-uy=><~]))"].join("|");

	const regex = new RegExp(pattern, "g");
	return str.replace(regex, "");
};

function restart() {
	console.log("restarting");
	win.webContents.send("result", {
		data: "\n\n<end>"
	});
	if (runningShell) runningShell.kill();
	runningShell = undefined;
	currentPrompt = undefined;
	alpacaReady = false;
	alpacaHalfReady = false;
	initChat();
}

function initChat() {
	if (runningShell) {
		win.webContents.send("ready");
		return;
	}
	const ptyProcess = pty.spawn(shell, [], config);
	runningShell = ptyProcess;
	ptyProcess.onData((res) => {
		res = stripAnsi(res);
		console.log(`//> ${res}`);
		if ((res.includes("llama_model_load: invalid model file") || res.includes("llama_model_load: failed to open") || res.includes("llama_init_from_file: failed to load model")) && res.includes("main: error: failed to load model")) {
			if (runningShell) runningShell.kill();
			win.webContents.send("modelPathValid", { data: false });
		} else if (res.includes("\n>") && !alpacaReady) {
			alpacaHalfReady = true;
		} else if (alpacaHalfReady && !alpacaReady) {
			alpacaReady = true;
			checkAVX = false;
			win.webContents.send("ready");
			console.log("ready!");
		} else if (((res.startsWith("llama_model_load:") && res.includes("sampling parameters: ")) || (res.startsWith("main: interactive mode") && res.includes("sampling parameters: "))) && !checkAVX) {
			checkAVX = true;
			console.log("checking avx compat");
		} else if (res.match(/PS [A-Z]:.*>/) && checkAVX) {
			console.log("avx2 incompatible, retrying with avx1");
			if (runningShell) runningShell.kill();
			runningShell = undefined;
			currentPrompt = undefined;
			alpacaReady = false;
			alpacaHalfReady = false;
			supportsAVX2 = false;
			checkAVX = false;
			store.set("supportsAVX2", false);
			initChat();
		} else if (((res.match(/PS [A-Z]:.*>/) && platform == "win32") || (res.match(/bash-[0-9]+\.?[0-9]*\$/) && platform == "darwin") || (res.match(/([a-zA-Z0-9]|_|-)+@([a-zA-Z0-9]|_|-)+:?~(\$|#)/) && platform == "linux")) && alpacaReady) {
			restart();
		} else if (res.includes("\n>") && alpacaReady) {
			win.webContents.send("result", {
				data: "\n\n<end>"
			});
		} else if (!res.startsWith(currentPrompt) && !res.startsWith("Using the given web search results, answer the following query:") && alpacaReady) {
			if (platform == "darwin") res = res.replaceAll("^C", "");
			win.webContents.send("result", {
				data: res
			});
		}
	});

	const params = store.get("params");
	if (params.model_type == "alpaca") {
		var revPrompt = "### Instruction:";
	} else if (params.model_type == "vicuna") {
		var revPrompt = "### Human:";
	} else {
		var revPrompt = "User:";
	}
	if (params.model_type == "alpaca") {
		var promptFile = "alpaca.txt";
	} else if (params.model_type == "vicuna") {
		var promptFile = "vicuna.txt";
	} else {
		var promptFile = "llama.txt";
	}
	const chatArgs = `-i --interactive-first -ins -r "${revPrompt}" -f "${path.resolve(__dirname, "bin", "prompts", promptFile)}"`;
	const paramArgs = `-m "${modelPath}" -n -1 --ctx_size 2048 --temp ${params.temp} --top_k ${params.top_k} --top_p ${params.top_p} --threads ${threads} --batch_size 512 --repeat_last_n ${params.repeat_last_n} --repeat_penalty ${params.repeat_penalty} --seed ${params.seed}`;
	if (platform == "win32") {
		runningShell.write(`[System.Console]::OutputEncoding=[System.Console]::InputEncoding=[System.Text.Encoding]::UTF8; ."${path.resolve(__dirname, "bin", supportsAVX2 ? "" : "no_avx2", "chat.exe")}" ${paramArgs} ${chatArgs}\r`);
	} else if (platform == "darwin") {
		const macArch = arch == "x64" ? "chat_mac_x64" : "chat_mac_arm64";
		runningShell.write(`"${path.resolve(__dirname, "bin", macArch)}" ${paramArgs} ${chatArgs}\r`);
	} else {
		runningShell.write(`"${path.resolve(__dirname, "bin", "chat")}" ${paramArgs} ${chatArgs}\r`);
	}
}
ipcMain.on("startChat", () => {
	initChat();
});

ipcMain.on("message", async (_event, { data }) => {
	currentPrompt = data;
	if (runningShell) {
		if (store.get("params").webAccess) {
			runningShell.write(`${await queryToPrompt(data)}\r`);
		} else {
			runningShell.write(`${data}\r`);
		}
	}
});
ipcMain.on("stopGeneration", () => {
	if (runningShell) {
		if (runningShell) runningShell.kill();
		runningShell = undefined;
		currentPrompt = undefined;
		alpacaReady = false;
		alpacaHalfReady = false;
		initChat();
		setTimeout(() => {
			win.webContents.send("result", {
				data: "\n\n<end>"
			});
		}, 200);
	}
});
ipcMain.on("getCurrentModel", () => {
	win.webContents.send("currentModel", {
		data: store.get("modelPath")
	});
});

ipcMain.on("pickFile", () => {
	dialog
		.showOpenDialog(win, {
			title: "Choose Alpaca GGML model",
			filters: [
				{
					name: "GGML model",
					extensions: ["bin"]
				}
			],
			properties: ["dontAddToRecent", "openFile"]
		})
		.then((obj) => {
			if (!obj.canceled) {
				win.webContents.send("pickedFile", {
					data: obj.filePaths[0]
				});
			}
		});
});

ipcMain.on("pickAudioFile", () => {
	dialog
		.showOpenDialog(win, {
			title: "Choose Audio File",
			filters: [
				{
					name: "Audio file",
					extensions: ["mp3"]
				}
			],
			properties: ["dontAddToRecent", "openFile"]
		})
		.then((obj) => {
			if (!obj.canceled) {
				win.webContents.send("pickedAudioFile", {
					data: obj.filePaths[0]
				});
			}
		});
});

ipcMain.on("storeParams", (_event, { params }) => {
	console.log(params);
	store.set("params", params);
	restart();
});
ipcMain.on("getParams", () => {
	win.webContents.send("params", store.get("params"));
});

ipcMain.on("webAccess", (_event, value) => {
	store.set("params", {
		...store.get("params"),
		webAccess: value
	});
});

ipcMain.on("restart", restart);

process.on("unhandledRejection", () => { });
process.on("uncaughtException", () => { });
process.on("uncaughtExceptionMonitor", () => { });
process.on("multipleResolves", () => { });
