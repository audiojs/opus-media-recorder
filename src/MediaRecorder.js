'use strict';
import {EventTarget, defineEventAttribute} from 'event-target-shim';

const AudioContext = global.AudioContext || global.webkitAudioContext;
const scriptPath = document.currentScript.src;
const scriptDirectory = scriptPath.substring(0, scriptPath.lastIndexOf('/')) + '/';
const BUFFER_SIZE = 4096;

/**
 * Reference: https://w3c.github.io/mediacapture-record/#mediarecorder-api
 * @extends EventTarget
 */
class MediaRecorder extends EventTarget {
  /**
   *
   * @param {MediaStream} stream - The MediaStream to be recorded. This will
   *          be the value of the stream attribute.
   * @param {MediaRecorderOptions} [options] - A dictionary of options to for
   *          the UA instructing how the recording will take part.
   *          options.mimeType, if present, will become the value of mimeType
   *          attribute.
   */
  constructor (stream, options = {}) {
    const { mimeType, audioBitsPerSecond, videoBitsPerSecond, bitsPerSecond } = options; // eslint-disable-line
    super();
    // Attributes for the specification conformance. These have their own getters.
    this._stream = stream;
    this._state = 'inactive';
    this._mimeType = mimeType || '';
    this._audioBitsPerSecond = audioBitsPerSecond || bitsPerSecond;
    /** @type {'inactive'|'readyToInit'|'encoding'|'closed'} */
    this.workerState = 'inactive';

    this._initWorker();

    // Get channel count and sampling rate
    // channelCount: https://www.w3.org/TR/mediacapture-streams/#media-track-settings
    // sampleRate: https://developer.mozilla.org/en-US/docs/Web/API/BaseAudioContext/sampleRate
    this.context = new AudioContext();
    let tracks = this.stream.getAudioTracks();
    if (!tracks[0]) {
      throw new Error('DOMException: UnkownError, media track not found.');
    }
    this.channelCount = tracks[0].getSettings().channelCount || 1;
    this.sampleRate = this.context.sampleRate;

    /** @type {MediaStreamAudioSourceNode} */
    this.source = this.context.createMediaStreamSource(this.stream);
    /** @type {ScriptProcessorNode} */
    this.processor = this.context.createScriptProcessor(BUFFER_SIZE, this.channelCount, this.channelCount);
  }

  /**
   * The MediaStream [GETUSERMEDIA] to be recorded.
   * @return {MediaStream}
   */
  get stream () {
    return this._stream;
  }

  /**
   * The MIME type [RFC2046] that has been selected as the container for
   * recording. This entry includes all the parameters to the base
   * mimeType. The UA should be able to play back any of the MIME types
   * it supports for recording. For example, it should be able to display
   * a video recording in the HTML <video> tag. The default value for
   * this property is platform-specific.
   * @return {string}
   */
  get mimeType () {
    return this._mimeType;
  }

  /**
   * The current state of the MediaRecorder object. When the MediaRecorder
   * is created, the UA MUST set this attribute to inactive.
   * @return {"inactive"|"recording"|"paused"}
   */
  get state () {
    return this._state;
  }

  /**
   * The value of the Video encoding. Unsupported.
   * @return {undefined}
   */
  get videoBitsPerSecond () {
    // Video encoding is not supported
    return undefined;
  }

  /**
   * The value of the Audio encoding target bit rate that was passed to
   * the Platform (potentially truncated, rounded, etc), or the calculated one
   * if the user has specified bitsPerSecond.
   * @return {number|undefined}
   */
  get audioBitsPerSecond () {
    return this._audioBitsPerSecond;
  }

  /**
   * Initialize worker
   * @param {string} mimeType - Optional and currently not used. Use this if
   *                            a different mimeType other than this.mimeType needed.
   */
  _initWorker (mimeType = undefined) {
    if (typeof mimeType === 'undefined') {
      mimeType = this._mimeType;
    }

    // Parse MIME Type
    if (!MediaRecorder.isTypeSupported(mimeType)) {
      throw new TypeError('invalid arguments, a MIME Type is not supported');
    }

    // Initialize worker
    switch (MediaRecorder._parseType(mimeType).subtype) {
      case 'wave':
      case 'wav':
        // TODO: try using type: 'module' when borwsers start supporting
        this.worker = new Worker(scriptDirectory + 'WaveWorker.js');
        break;

      case 'webm':
        this.worker = new Worker(scriptDirectory + 'WebMOpusWorker.js');
        this._mimeType = 'audio/webm';
        break;

      case 'ogg':
      default:
        this.worker = new Worker(scriptDirectory + 'OggOpusWorker.js');
        this._mimeType = 'audio/ogg';
        break;
    }

    this.worker.onmessage = (e) => this._onmessageFromWorker(e);
    this.worker.onerror = (e) => this._onerrorFromWorker(e);
    this.workerState = 'inactive';
  }

  /**
   * Post message to the encoder web worker.
   * @param {"init"|"pushInputData"|"getEncodedData"|"done"} command - Type of message to send to the worker
   * @param {object} message - Payload to the worker
   */
  _postMessageToWorker (command, message = {}) {
    switch (command) {
      case 'init':
        // Initialize the worker
        let { sampleRate, channelCount, bitsPerSecond } = message;
        this.worker.postMessage({ command, sampleRate, channelCount, bitsPerSecond });
        this.workerState = 'encoding';

        // Start streaming
        this.source.connect(this.processor);
        this.processor.connect(this.context.destination);
        let eventToPush = new global.Event('start');
        this.dispatchEvent(eventToPush);
        break;

      case 'pushInputData':
        // Pass input audio buffer to the encoder to encode.
        // The worker MAY trigger 'encodedData'.
        let { channelBuffers, length, duration } = message;
        this.worker.postMessage({
          command, channelBuffers, length, duration
        }, channelBuffers.map(a => a.buffer));
        break;

      case 'getEncodedData':
        // Request encoded result.
        // Expected 'encodedData' event from the worker
        this.worker.postMessage({ command });
        break;

      case 'done':
        // Tell encoder finallize the job and destory itself.
        // Expected 'lastEncodedData' event from the worker.
        this.worker.postMessage({ command });
        break;

      default:
        // This is an error case
        break;
    }
  }

  /**
   * onmessage() callback from the worker.
   * @param {message} event - message from the worker
   */
  _onmessageFromWorker (event) {
    const { command, buffers } = event.data;
    let eventToPush;
    switch (command) {
      case 'readyToInit':
        const { sampleRate, channelCount } = this;
        this.workerState = 'readyToInit';

        // If start() is already called initialize worker
        if (this.state === 'recording') {
          this._postMessageToWorker('init',
                                    { sampleRate,
                                      channelCount,
                                      bitsPerSecond: this.audioBitsPerSecond});
        }
        break;

      case 'encodedData':
      case 'lastEncodedData':
        let data = new Blob(buffers, {'type': this._mimeType});
        eventToPush = new global.Event('dataavailable');
        eventToPush.data = data;
        this.dispatchEvent(eventToPush);

        // Detect of stop() called before
        if (command === 'lastEncodedData') {
          eventToPush = new global.Event('stop');
          this.dispatchEvent(eventToPush);

          this.workerState = 'closed';
        }
        break;

      default:
        break; // Ignore
    }
  }

  /**
   * onerror() callback from the worker.
   * @param {ErrorEvent} error - error object from the worker
   */
  _onerrorFromWorker (error) {
    // Stop stream first
    this.source.disconnect();
    this.processor.disconnect();

    this.worker.terminate();
    this.workerState = 'closed';

    // Send message to host
    let message = [
      'FileName: ' + error.filename,
      'LineNumber: ' + error.lineno,
      'Message: ' + error.message
    ].join(' - ');
    let errorToPush = new global.Event('error');
    errorToPush.name = 'UnknownError';
    errorToPush.message = message;
    this.dispatchEvent(errorToPush);
  }

  /**
   * Enable onaudioprocess() callback.
   * @param {number} timeslice - In seconds. MediaRecorder should request data
   *                              from the worker every timeslice seconds.
   */
  _enableAudioProcessCallback (timeslice) {
    // pass frame buffers to the worker
    let elapsedTime = 0;
    this.processor.onaudioprocess = (e) => {
      const { inputBuffer, playbackTime } = e; // eslint-disable-line
      const { sampleRate, length, duration, numberOfChannels } = inputBuffer; // eslint-disable-line

      // Create channel buffers to pass to the worker
      const channelBuffers = new Array(numberOfChannels);
      for (let i = 0; i < numberOfChannels; i++) {
        channelBuffers[i] = inputBuffer.getChannelData(i);
      }

      // Pass data to the worker
      const message = { channelBuffers, length, duration };
      this._postMessageToWorker('pushInputData', message);

      // Calculate time
      elapsedTime += duration;
      if (elapsedTime >= timeslice) {
        this._postMessageToWorker('getEncodedData');
        elapsedTime = 0;
      }
    };
  }

  /**
   * Begins recording media; this method can optionally be passed a timeslice
   * argument with a value in milliseconds.
   * @param {number} timeslice - If this is specified, the media will be captured
   *        in separate chunks of that duration, rather than the default behavior
   *        of recording the media in a single large chunk. In other words, an
   *        undefined value of timeslice will be understood as the largest long value.
   */
  start (timeslice = Number.MAX_SAFE_INTEGER) {
    if (this.state !== 'inactive') {
      throw new Error('DOMException: INVALID_STATE_ERR, state must be inactive.');
    }
    if (timeslice < 0) {
      throw new TypeError('invalid arguments, timeslice should be 0 or higher.');
    }
    timeslice /= 1000; // Convert milliseconds to seconds

    // Check worker is closed (usually by stop()) and init.
    if (this.workerState === 'closed') {
      this._initWorker();
    }

    this._state = 'recording';
    this._enableAudioProcessCallback(timeslice);

    // If the worker is already loaded then start
    if (this.workerState === 'readyToInit') {
      const { sampleRate, channelCount } = this;
      this._postMessageToWorker('init',
                                { sampleRate,
                                  channelCount,
                                  bitsPerSecond: this.audioBitsPerSecond });
    }
  }

  /**
   * Stops recording, at which point a dataavailable event containing
   * the final Blob of saved data is fired. No more recording occurs.
   */
  stop () {
    if (this.state === 'inactive') {
      throw new Error('DOMException: INVALID_STATE_ERR, state must NOT be inactive.');
    }

    // Stop stream first
    this.source.disconnect();
    this.processor.disconnect();

    // Stop event will be triggered at _onmessageFromWorker(),
    this._postMessageToWorker('done');

    this._state = 'inactive';
  }

  /**
   * Pauses the recording of media.
   */
  pause () {
    if (this.state === 'inactive') {
      throw new Error('DOMException: INVALID_STATE_ERR, state must NOT be inactive.');
    }

    // Stop stream first
    this.source.disconnect();
    this.processor.disconnect();

    let event = new global.Event('pause');
    this.dispatchEvent(event);
    this._state = 'paused';
  }

  /**
   * Resumes recording of media after having been paused.
   */
  resume () {
    if (this.state === 'inactive') {
      throw new Error('DOMException: INVALID_STATE_ERR, state must NOT be inactive.');
    }

    // Restart streaming data
    this.source.connect(this.processor);
    this.processor.connect(this.context.destination);

    let event = new global.Event('resume');
    this.dispatchEvent(event);
    this._state = 'recording';
  }

  /**
   * Requests a Blob containing the saved data received thus far (or since
   * the last time requestData() was called. After calling this method,
   * recording continues, but in a new Blob.
   */
  requestData () {
    if (this.state === 'inactive') {
      throw new Error('DOMException: INVALID_STATE_ERR, state must NOT be inactive.');
    }

    // dataavailable event will be triggerd at _onmessageFromWorker()
    this._postMessageToWorker('getEncodedData');
  }

  /**
   * Returns a Boolean value indicating if the given MIME type is supported
   * by the current user agent .
   * @param {string} typeType - A MIME Type, including parameters when needed,
   *          specifying a container and/or codec formats for recording.
   * @return {boolean}
   */
  static isTypeSupported (mimeType) {
    // See: https://w3c.github.io/mediacapture-record/#dom-mediarecorder-istypesupported

    // 1. If empty string, return true.
    if (typeof mimeType === 'string' && !mimeType) {
      return true;
    }
    try {
      var {type, subtype, codec} = MediaRecorder._parseType(mimeType);
    } catch (error) {
      // 2. If not a valid string, return false.
      return false;
    }
    if (type !== 'audio' ||
      !(subtype === 'ogg' || subtype === 'webm' ||
        subtype === 'wave' || subtype === 'wav')) {
      // 3,4. If type and subtype are unsupported the return false.
      return false;
    }
    // 5. If codec is unsupported then return false.
    // 6. If the specified combination of all is not supported than return false.
    switch (subtype) {
      case 'ogg':
        if (codec !== 'opus' && codec) {
          return false;
        }
        break;
      case 'webm':
        if (codec !== 'opus' && codec) {
          return false;
        }
        break;
      case 'wave':
      case 'wav':
        if (codec) {
          return false; // Currently only supports signed 16 bits
        }
        break;
    }
    // 7. return true.
    return true;
  }

  /**
   * Parse MIME. A helper function for isTypeSupported() and etc.
   * @param {string} mimeType - typeType - A MIME Type, including parameters when needed,
   *          specifying a container and/or codec formats for recording.
   * @return {?object} - An object with type, subtype, codec attributes
   *          if parsed correctly. null is returned if parsing failed.
   *          If mimeType is an empty string then return an object with attributes
   *          are empty strings
   */
  static _parseType (mimeType) {
    try {
      const regex = /^(\w+)\/(\w+)(;\s*codecs=(\w+))?$/;
      var [, type, subtype, , codec] = mimeType.match(regex);
    } catch (error) {
      if (typeof mimeType === 'string' && !mimeType) {
        return {type: '', subtype: '', codec: ''};
      }
      return null;
    }
    return {type, subtype, codec};
  }
}

// EventHandler attributes.
// This code is a non-standard EventTarget but required by event-target-shim.
[
  'start', // Called to handle the {@link MediaRecorder#start} event.
  'stop', // Called to handle the stop event.
  'dataavailable', /* Called to handle the dataavailable event. The Blob of
                        recorded data is contained in this event and can be
                        accessed via its data attribute. */
  'pause', // Called to handle the pause event.
  'resume', // Called to handle the resume event.
  'error' // Called to handle a MediaRecorderErrorEvent.
].forEach(name => defineEventAttribute(MediaRecorder.prototype, name));

// MS Edge specific monkey patching:
// onaudioprocess callback cannot be triggered more than twice when postMessage
// uses the seconde transfer argument. So disable the transfer argument only in Edge.
if (/Edge/.test(navigator.userAgent)) {
  (function () {
    var original = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function (message, transfer = null) {
      original.apply(this, [message]);
    };
  })();
}

export default MediaRecorder;
