export class SyncManager {
  constructor(socket, roomId, videoElement) {
    this.socket = socket;
    this.roomId = roomId;
    this.videoElement = videoElement;
    this.isRemoteUpdate = false; // Flag to prevent infinite broadcast loops

    this.handleVideoState = (data) => {
      this.isRemoteUpdate = true;
      
      if (data.type === 'play') {
        // Sync time if drift is larger than 0.5 seconds
        if (typeof data.timestamp === 'number' && Math.abs(this.videoElement.currentTime - data.timestamp) > 0.5) {
          this.videoElement.currentTime = data.timestamp;
        }
        this.videoElement.play().catch(e => console.log('Autoplay prevented by browser', e));
      } else if (data.type === 'pause') {
        if (typeof data.timestamp === 'number') {
          this.videoElement.currentTime = data.timestamp;
        }
        this.videoElement.pause();
      } else if (data.type === 'seek') {
        if (typeof data.timestamp === 'number') {
          this.videoElement.currentTime = data.timestamp;
        }
      }

      // Reset flag after a short delay so local events can fire again
      setTimeout(() => {
        this.isRemoteUpdate = false;
      }, 200);
    };

    this.setupListeners();
  }

  setupListeners() {
    this.socket.on('video-state-change', this.handleVideoState);
  }

  broadcastPlay(timestamp) {
    if (this.isRemoteUpdate) return;
    this.socket.emit('video-state-change', { roomId: this.roomId, type: 'play', timestamp, isInstructor: true });
  }

  broadcastPause(timestamp) {
    if (this.isRemoteUpdate) return;
    this.socket.emit('video-state-change', { roomId: this.roomId, type: 'pause', timestamp, isInstructor: true });
  }

  broadcastSeek(timestamp) {
    if (this.isRemoteUpdate) return;
    this.socket.emit('video-state-change', { roomId: this.roomId, type: 'seek', timestamp, isInstructor: true });
  }

  destroy() {
    if (this.handleVideoState) {
      this.socket.off('video-state-change', this.handleVideoState);
    }
  }
}
