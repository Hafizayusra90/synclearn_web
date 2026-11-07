import React, { useRef, useEffect, useState } from 'react';
import { socket } from '../socket';
import { SyncManager } from '../utils/SyncManager';
import TimelineOverlay from './TimelineOverlay';
import './VideoPlayer.css';

// Helper to extract YouTube Video ID from standard or short URLs
export function getYouTubeId(url) {
  if (!url) return null;
  const regExp = /^.*(youtu.be\/|v\/|u\/\w\/|embed\/|watch\?v=|&v=)([^#&?]*).*/;
  const match = url.match(regExp);
  return (match && match[2].length === 11) ? match[2] : null;
}

// Helper to format seconds to mm:ss
export function formatVideoTime(secs) {
  if (!secs || isNaN(secs) || secs < 0) return '0:00';
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  return `${m}:${s < 10 ? '0' : ''}${s}`;
}

const VideoPlayer = ({
  roomId,
  isInstructor = false,
  user,
  theme,
  pinnedDoubts = [],
  onPinDoubt,
  onResolveDoubt
}) => {
  const videoRef = useRef(null);
  const ytContainerRef = useRef(null);
  const ytPlayerRef = useRef(null);
  const isYtApiLoadedRef = useRef(false);
  const syncManagerRef = useRef(null);

  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);

  // Active theme calculation & dynamic observer
  const [currentTheme, setCurrentTheme] = useState(() => {
    if (theme) return theme;
    if (typeof document !== 'undefined') {
      return document.documentElement.getAttribute('data-theme') || 
             document.querySelector('.room-container')?.getAttribute('data-theme') || 
             localStorage.getItem('synclearn-theme-v2') || 
             'light';
    }
    return 'light';
  });

  useEffect(() => {
    if (theme) {
      setCurrentTheme(theme);
    }
    const updateThemeFromDOM = () => {
      const activeT = (typeof document !== 'undefined' && (
        document.documentElement.getAttribute('data-theme') || 
        document.querySelector('.room-container')?.getAttribute('data-theme') || 
        localStorage.getItem('synclearn-theme-v2')
      )) || 'light';
      setCurrentTheme(activeT);
    };

    updateThemeFromDOM();
    if (typeof document !== 'undefined') {
      const observer = new MutationObserver(updateThemeFromDOM);
      observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
      return () => observer.disconnect();
    }
  }, [theme]);

  const isLight = currentTheme === 'light';

  // Doubt Pinning State
  const [isPinModalOpen, setIsPinModalOpen] = useState(false);
  const [doubtText, setDoubtText] = useState('');
  const [capturedTimestamp, setCapturedTimestamp] = useState(0);
  const [localVideoDoubts, setLocalVideoDoubts] = useState([]);

  // Video Source state
  const [mediaType, setMediaType] = useState('none'); // 'none' | 'direct' | 'youtube'
  const [videoSrc, setVideoSrc] = useState('');
  const [videoFileName, setVideoFileName] = useState('');
  const [ytVideoId, setYtVideoId] = useState('');
  const [isDragging, setIsDragging] = useState(false);
  const [inputUrl, setInputUrl] = useState('');

  // Change YouTube Modal State (Teacher Only)
  const [isChangeModalOpen, setIsChangeModalOpen] = useState(false);
  const [newYtUrlInput, setNewYtUrlInput] = useState('');
  const [ytError, setYtError] = useState('');

  // Local Video Upload State
  const [isUploadingVideo, setIsUploadingVideo] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [uploadFileName, setUploadFileName] = useState('');
  const [uploadSuccessBanner, setUploadSuccessBanner] = useState(false);
  const [isLocalUploader, setIsLocalUploader] = useState(false);

  // Sync incoming pinnedDoubts prop
  useEffect(() => {
    if (Array.isArray(pinnedDoubts) && pinnedDoubts.length > 0) {
      setLocalVideoDoubts(prev => {
        const map = new Map();
        [...pinnedDoubts, ...prev].forEach(d => {
          if (d && d.id) map.set(d.id, d);
        });
        return Array.from(map.values());
      });
    }
  }, [pinnedDoubts]);

  // Listen directly for real-time doubt events on socket
  useEffect(() => {
    const handleRemoteDoubtPinned = (doubt) => {
      if (!doubt) return;
      setLocalVideoDoubts(prev => {
        if (prev.some(d => d.id === doubt.id)) return prev;
        return [doubt, ...prev];
      });
    };
    const handleRemoteDoubtResolved = ({ doubtId }) => {
      setLocalVideoDoubts(prev => prev.filter(d => d.id !== doubtId));
    };

    socket.on('doubt-pinned', handleRemoteDoubtPinned);
    socket.on('doubt-resolved', handleRemoteDoubtResolved);
    return () => {
      socket.off('doubt-pinned', handleRemoteDoubtPinned);
      socket.off('doubt-resolved', handleRemoteDoubtResolved);
    };
  }, []);

  // Initialize SyncManager for direct HTML5 video
  useEffect(() => {
    if (videoRef.current && mediaType === 'direct') {
      syncManagerRef.current = new SyncManager(socket, roomId, videoRef.current);
    }
    return () => {
      if (syncManagerRef.current) {
        syncManagerRef.current.destroy();
        syncManagerRef.current = null;
      }
    };
  }, [roomId, mediaType, videoSrc]);

  // Listen for remote video source updates (YouTube URL / Lecture Video change broadcast)
  useEffect(() => {
    const handleRemoteSourceChange = (data) => {
      if (!data) return;
      if (data.mediaType === 'youtube') {
        setMediaType('youtube');
        setYtVideoId(data.ytVideoId);
        setVideoSrc('');
        if (data.videoTitle) setVideoFileName(data.videoTitle);
      } else if (data.mediaType === 'direct') {
        setMediaType('direct');
        setVideoSrc(data.videoSrc);
        setYtVideoId('');
        if (data.videoTitle) setVideoFileName(data.videoTitle);
      }
    };

    socket.on('video-source-change', handleRemoteSourceChange);

    // Request current room video state if joining active session
    const cleanRoom = String(roomId || '').replace(/[^a-zA-Z0-9_-]/g, '').trim();
    if (cleanRoom) {
      socket.emit('request-video-state', { roomId: cleanRoom });
    }

    return () => {
      socket.off('video-source-change', handleRemoteSourceChange);
    };
  }, [roomId]);

  // Listen for YouTube sync commands from instructor
  useEffect(() => {
    const handleYtSyncState = (data) => {
      if (mediaType !== 'youtube' || !ytPlayerRef.current) return;
      if (typeof ytPlayerRef.current.getPlayerState !== 'function') return;

      try {
        if (data.type === 'play') {
          if (typeof data.timestamp === 'number') {
            const cur = ytPlayerRef.current.getCurrentTime ? ytPlayerRef.current.getCurrentTime() : 0;
            if (Math.abs(cur - data.timestamp) > 1.5) {
              ytPlayerRef.current.seekTo(data.timestamp, true);
            }
          }
          ytPlayerRef.current.playVideo && ytPlayerRef.current.playVideo();
        } else if (data.type === 'pause') {
          if (typeof data.timestamp === 'number') {
            ytPlayerRef.current.seekTo(data.timestamp, true);
          }
          ytPlayerRef.current.pauseVideo && ytPlayerRef.current.pauseVideo();
        } else if (data.type === 'seek' && typeof data.timestamp === 'number') {
          ytPlayerRef.current.seekTo(data.timestamp, true);
        }
      } catch (err) {
        console.warn('YouTube sync event error:', err);
      }
    };

    socket.on('video-state-change', handleYtSyncState);
    return () => {
      socket.off('video-state-change', handleYtSyncState);
    };
  }, [mediaType]);

  // Load YouTube IFrame API script once
  useEffect(() => {
    if (!window.YT) {
      const tag = document.createElement('script');
      tag.src = 'https://www.youtube.com/iframe_api';
      const firstScriptTag = document.getElementsByTagName('script')[0];
      firstScriptTag.parentNode.insertBefore(tag, firstScriptTag);

      window.onYouTubeIframeAPIReady = () => {
        isYtApiLoadedRef.current = true;
      };
    } else {
      isYtApiLoadedRef.current = true;
    }
  }, []);

  // Initialize or smoothly update YouTube Player when ytVideoId changes
  useEffect(() => {
    if (mediaType !== 'youtube' || !ytVideoId) return;

    let isCancelled = false;

    const setupPlayer = () => {
      if (isCancelled) return;

      // 1. If player already exists and loadVideoById is callable, smoothly switch video
      if (ytPlayerRef.current && typeof ytPlayerRef.current.loadVideoById === 'function') {
        try {
          ytPlayerRef.current.loadVideoById({
            videoId: ytVideoId,
            startSeconds: 0
          });
          return;
        } catch (err) {
          console.warn('loadVideoById failed, creating fresh player mount:', err);
        }
      }

      // 2. Otherwise create a clean DOM mount inside ytContainerRef
      if (!ytContainerRef.current) return;

      if (ytPlayerRef.current && typeof ytPlayerRef.current.destroy === 'function') {
        try {
          ytPlayerRef.current.destroy();
        } catch (e) {}
        ytPlayerRef.current = null;
      }

      ytContainerRef.current.innerHTML = '';
      const mountDiv = document.createElement('div');
      mountDiv.id = 'synclearn-yt-iframe';
      ytContainerRef.current.appendChild(mountDiv);

      if (window.YT && window.YT.Player) {
        ytPlayerRef.current = new window.YT.Player(mountDiv, {
          videoId: ytVideoId,
          playerVars: {
            autoplay: 1,
            controls: 1,
            modestbranding: 1,
            rel: 0,
            enablejsapi: 1,
            playsinline: 1,
            origin: window.location.origin
          },
          events: {
            onStateChange: (event) => {
              if (!isInstructor) return;
              try {
                const cur = ytPlayerRef.current?.getCurrentTime() || 0;
                const cleanRoom = String(roomId || '').replace(/[^a-zA-Z0-9_-]/g, '').trim();
                // 1: Playing, 2: Paused, 3: Buffering/Seeking
                if (event.data === 1) {
                  socket.emit('video-state-change', { roomId: cleanRoom, type: 'play', timestamp: cur, isInstructor: true });
                  socket.emit('workspace-view-sync', { roomId: cleanRoom, view: 'video' });
                } else if (event.data === 2) {
                  socket.emit('video-state-change', { roomId: cleanRoom, type: 'pause', timestamp: cur, isInstructor: true });
                } else if (event.data === 3) {
                  socket.emit('video-state-change', { roomId: cleanRoom, type: 'seek', timestamp: cur, isInstructor: true });
                }
              } catch (e) {}
            }
          }
        });
      }
    };

    if (window.YT && window.YT.Player) {
      setupPlayer();
    } else {
      const checkInterval = setInterval(() => {
        if (window.YT && window.YT.Player) {
          clearInterval(checkInterval);
          setupPlayer();
        }
      }, 250);
      return () => {
        isCancelled = true;
        clearInterval(checkInterval);
      };
    }

    return () => {
      isCancelled = true;
    };
  }, [mediaType, ytVideoId, roomId, isInstructor]);

  // Poll YouTube video position & duration so timestamp is always live
  useEffect(() => {
    if (mediaType !== 'youtube') return;
    const timer = setInterval(() => {
      if (ytPlayerRef.current && typeof ytPlayerRef.current.getCurrentTime === 'function') {
        try {
          const cur = ytPlayerRef.current.getCurrentTime();
          if (typeof cur === 'number' && !isNaN(cur)) {
            setCurrentTime(cur);
          }
          const dur = ytPlayerRef.current.getDuration();
          if (typeof dur === 'number' && !isNaN(dur) && dur > 0) {
            setDuration(dur);
          }
        } catch (e) {}
      }
    }, 500);
    return () => clearInterval(timer);
  }, [mediaType]);

  // Video seeking capability across HTML5 & YouTube
  const seekToTimestamp = (seconds) => {
    if (typeof seconds !== 'number' || isNaN(seconds)) return;
    if (mediaType === 'youtube' && ytPlayerRef.current && typeof ytPlayerRef.current.seekTo === 'function') {
      ytPlayerRef.current.seekTo(seconds, true);
      ytPlayerRef.current.playVideo && ytPlayerRef.current.playVideo();
    } else if (videoRef.current) {
      videoRef.current.currentTime = seconds;
      videoRef.current.play && videoRef.current.play().catch(() => {});
    }
    setCurrentTime(seconds);

    // If teacher seeks, broadcast to all students
    if (isInstructor) {
      const cleanRoom = String(roomId || '').replace(/[^a-zA-Z0-9_-]/g, '').trim();
      socket.emit('video-state-change', { roomId: cleanRoom, type: 'seek', timestamp: seconds, isInstructor: true });
    }
  };

  // Listen for seek commands from doubt clicks
  useEffect(() => {
    const handleSeekToVideoTime = (data) => {
      if (data && typeof data.timestamp === 'number') {
        seekToTimestamp(data.timestamp);
      }
    };
    socket.on('seek-to-video-time', handleSeekToVideoTime);
    return () => {
      socket.off('seek-to-video-time', handleSeekToVideoTime);
    };
  }, [mediaType, isInstructor, roomId]);

  // Doubt Pinning Handlers
  const handleOpenPinModal = () => {
    let currentSec = 0;
    if (mediaType === 'youtube' && ytPlayerRef.current && typeof ytPlayerRef.current.getCurrentTime === 'function') {
      currentSec = ytPlayerRef.current.getCurrentTime() || 0;
    } else if (videoRef.current) {
      currentSec = videoRef.current.currentTime || 0;
    } else {
      currentSec = currentTime || 0;
    }
    setCapturedTimestamp(currentSec);
    setDoubtText('');
    setIsPinModalOpen(true);
  };

  const handleSubmitPinDoubt = (e) => {
    e && e.preventDefault();
    const cleanText = doubtText.trim() || `Doubt at ${formatVideoTime(capturedTimestamp)}`;
    const doubtObj = {
      id: 'doubt_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4),
      senderName: user?.name || (isInstructor ? 'Instructor' : 'Student'),
      senderRole: user?.role || 'student',
      time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      text: cleanText,
      videoTimestamp: capturedTimestamp,
      videoTimeFormatted: formatVideoTime(capturedTimestamp),
      isDoubt: true,
    };

    setLocalVideoDoubts(prev => [doubtObj, ...prev]);

    if (onPinDoubt) {
      onPinDoubt(doubtObj);
    }

    const cleanRoom = String(roomId || '').replace(/[^a-zA-Z0-9_-]/g, '').trim();
    socket.emit('pin-doubt', { roomId: cleanRoom, doubt: doubtObj });
    socket.emit('pin-annotation', {
      roomId: cleanRoom,
      id: doubtObj.id,
      timestamp: capturedTimestamp,
      text: `${doubtObj.senderName}: ${cleanText}`
    });
    socket.emit('send-message', {
      roomId: cleanRoom,
      id: doubtObj.id,
      message: `❓ [Pinned Doubt at ${doubtObj.videoTimeFormatted}]: "${cleanText}"`,
      doubtQuestion: cleanText,
      senderName: doubtObj.senderName,
      senderRole: doubtObj.senderRole,
      isDoubt: true,
      doubtId: doubtObj.id,
      videoTimestamp: capturedTimestamp,
      videoTimeFormatted: doubtObj.videoTimeFormatted,
      time: doubtObj.time
    });

    setIsPinModalOpen(false);
    setDoubtText('');
  };

  // Direct HTML5 event handlers - Instructor or Video Uploader broadcasts to class!
  const canSyncPlayback = isInstructor || isLocalUploader;
  const handlePlay = () => {
    if (canSyncPlayback && syncManagerRef.current && videoRef.current) {
      syncManagerRef.current.broadcastPlay(videoRef.current.currentTime);
    }
  };

  const handlePause = () => {
    if (canSyncPlayback && syncManagerRef.current && videoRef.current) {
      syncManagerRef.current.broadcastPause(videoRef.current.currentTime);
    }
  };

  const handleSeek = () => {
    if (canSyncPlayback && syncManagerRef.current && videoRef.current) {
      syncManagerRef.current.broadcastSeek(videoRef.current.currentTime);
    }
  };

  const handleTimeUpdate = () => {
    if (videoRef.current) setCurrentTime(videoRef.current.currentTime);
  };

  const handleLoadedMetadata = () => {
    if (videoRef.current) setDuration(videoRef.current.duration);
  };

  // Submit initial media URL (from dropzone form)
  const handleUpdateMedia = (e) => {
    e && e.preventDefault();
    if (!isInstructor) return;
    const cleanUrl = inputUrl.trim();
    if (!cleanUrl) return;

    const cleanRoom = String(roomId || '').replace(/[^a-zA-Z0-9_-]/g, '').trim();
    const extractedYtId = getYouTubeId(cleanUrl);

    if (extractedYtId) {
      setMediaType('youtube');
      setYtVideoId(extractedYtId);
      setVideoFileName('YouTube Lecture Video');
      setVideoSrc('');
      socket.emit('video-source-change', {
        roomId: cleanRoom,
        mediaType: 'youtube',
        ytVideoId: extractedYtId,
        videoTitle: 'YouTube Lecture Video',
        instructorName: user?.name || 'Instructor',
        isInstructor: true,
        senderRole: 'instructor'
      });
      socket.emit('workspace-view-sync', { roomId: cleanRoom, view: 'video' });
    } else {
      setMediaType('direct');
      setVideoSrc(cleanUrl);
      setYtVideoId('');
      setVideoFileName('Direct Video Stream');
      socket.emit('video-source-change', {
        roomId: cleanRoom,
        mediaType: 'direct',
        videoSrc: cleanUrl,
        videoTitle: 'Direct Video Stream',
        instructorName: user?.name || 'Instructor',
        isInstructor: true,
        senderRole: 'instructor'
      });
      socket.emit('workspace-view-sync', { roomId: cleanRoom, view: 'video' });
    }

    setInputUrl('');
  };

  // Teacher Change YouTube Video Modal Submit
  const handleModalSubmitNewYt = (e) => {
    e && e.preventDefault();
    if (!isInstructor) return;
    const cleanUrl = newYtUrlInput.trim();
    if (!cleanUrl) {
      setYtError('Please enter a YouTube link or video ID.');
      return;
    }

    let extractedYtId = getYouTubeId(cleanUrl);
    // Allow direct 11-char ID (e.g. Tn6-PIqc4UM)
    if (!extractedYtId && cleanUrl.length === 11 && !cleanUrl.includes('/') && !cleanUrl.includes('?')) {
      extractedYtId = cleanUrl;
    }

    if (!extractedYtId) {
      setYtError('Invalid YouTube link. Please paste a full YouTube URL (e.g. https://www.youtube.com/watch?v=... or youtu.be/...)');
      return;
    }

    const cleanRoom = String(roomId || '').replace(/[^a-zA-Z0-9_-]/g, '').trim();
    setMediaType('youtube');
    setYtVideoId(extractedYtId);
    setVideoFileName('YouTube Lecture Video');
    setVideoSrc('');

    // Broadcast change to all students in room!
    socket.emit('video-source-change', {
      roomId: cleanRoom,
      mediaType: 'youtube',
      ytVideoId: extractedYtId,
      videoTitle: 'YouTube Lecture Video',
      instructorName: user?.name || 'Instructor',
      isInstructor: true,
      senderRole: 'instructor'
    });
    socket.emit('workspace-view-sync', { roomId: cleanRoom, view: 'video' });

    setNewYtUrlInput('');
    setYtError('');
    setIsChangeModalOpen(false);
  };

  // Local Video Upload and Classroom Sync (Teacher and Students)
  const handleLocalVideoFile = (file) => {
    if (!file) return;

    const cleanRoom = String(roomId || '').replace(/[^a-zA-Z0-9_-]/g, '').trim();
    if (!cleanRoom) {
      alert('Room ID is missing.');
      return;
    }

    const MAX_SIZE_MB = 150;
    if (file.size > MAX_SIZE_MB * 1024 * 1024) {
      alert(`The selected video file is too large (${(file.size / (1024 * 1024)).toFixed(1)} MB). Maximum allowed size is ${MAX_SIZE_MB} MB.`);
      return;
    }

    try {
      // 1. Show immediate local preview so user doesn't have a blank screen
      const blobUrl = URL.createObjectURL(file);
      setVideoSrc(blobUrl);
      setVideoFileName(file.name);
      setMediaType('direct');
      setYtVideoId('');
      setIsLocalUploader(true);
      setIsChangeModalOpen(false);

      // 2. Set upload tracking state
      setIsUploadingVideo(true);
      setUploadProgress(0);
      setUploadFileName(file.name);

      // 3. Upload file via XHR with progress to /api/v1/rooms/:roomId/upload-lecture
      const formData = new FormData();
      formData.append('lectureFile', file);
      formData.append('uploadedBy', user?.name || (isInstructor ? 'Instructor' : 'Student'));

      const xhr = new XMLHttpRequest();
      xhr.open('POST', `/api/v1/rooms/${cleanRoom}/upload-lecture`);

      xhr.upload.onprogress = (event) => {
        if (event.lengthComputable) {
          const percent = Math.round((event.loaded / event.total) * 100);
          setUploadProgress(percent);
        }
      };

      xhr.onload = () => {
        setIsUploadingVideo(false);
        if (xhr.status >= 200 && xhr.status < 300) {
          try {
            const resp = JSON.parse(xhr.responseText);
            if (resp.success && resp.material?.fileUrl) {
              const serverFileUrl = resp.material.fileUrl;
              setVideoSrc(serverFileUrl);
              setVideoFileName(file.name);

              // 4. Broadcast to teacher & all participants in room so everyone loads the uploaded video!
              socket.emit('video-source-change', {
                roomId: cleanRoom,
                mediaType: 'direct',
                videoSrc: serverFileUrl,
                videoTitle: file.name,
                uploadedBy: user?.name || (isInstructor ? 'Instructor' : 'Student'),
                instructorName: isInstructor ? (user?.name || 'Instructor') : 'Student',
                isInstructor: isInstructor,
                senderRole: isInstructor ? 'instructor' : 'student'
              });
              socket.emit('workspace-view-sync', { roomId: cleanRoom, view: 'video' });
              
              setUploadSuccessBanner(true);
              setTimeout(() => setUploadSuccessBanner(false), 5000);
            } else {
              alert('Video upload failed: ' + (resp.message || 'Server error'));
            }
          } catch (e) {
            console.error('Failed to parse upload response:', e);
          }
        } else {
          alert(`Failed to upload video (Status ${xhr.status}).`);
        }
      };

      xhr.onerror = () => {
        setIsUploadingVideo(false);
        alert('Network error while uploading video to classroom.');
      };

      xhr.send(formData);
    } catch (e) {
      console.error('Local video file handling error:', e);
      setIsUploadingVideo(false);
    }
  };

  // Manual YouTube sync triggers for Host
  const syncHostYtPlay = () => {
    if (!ytPlayerRef.current || !isInstructor) return;
    const cleanRoom = String(roomId || '').replace(/[^a-zA-Z0-9_-]/g, '').trim();
    const cur = ytPlayerRef.current.getCurrentTime ? ytPlayerRef.current.getCurrentTime() : 0;
    ytPlayerRef.current.playVideo && ytPlayerRef.current.playVideo();
    socket.emit('video-state-change', { roomId: cleanRoom, type: 'play', timestamp: cur, isInstructor: true });
  };

  const syncHostYtPause = () => {
    if (!ytPlayerRef.current || !isInstructor) return;
    const cleanRoom = String(roomId || '').replace(/[^a-zA-Z0-9_-]/g, '').trim();
    const cur = ytPlayerRef.current.getCurrentTime ? ytPlayerRef.current.getCurrentTime() : 0;
    ytPlayerRef.current.pauseVideo && ytPlayerRef.current.pauseVideo();
    socket.emit('video-state-change', { roomId: cleanRoom, type: 'pause', timestamp: cur, isInstructor: true });
  };

  // Merge prop pinnedDoubts and local optimistic doubts (deduplicated by ID)
  const mergedDoubtsMap = new Map();
  [...(pinnedDoubts || []), ...localVideoDoubts].forEach(d => {
    if (d && d.id && !mergedDoubtsMap.has(d.id)) {
      mergedDoubtsMap.set(d.id, d);
    }
  });
  const videoDoubts = Array.from(mergedDoubtsMap.values()).filter(d => typeof d?.videoTimestamp === 'number');

  return (
    <div
      className={`video-player-wrapper ${isLight ? 'light-theme' : 'dark-theme'}`}
      data-theme={currentTheme}
    >
      {/* Uploading Progress Banner for Local Video */}
      {isUploadingVideo && (
        <div className="video-sync-upload-banner">
          <div className="video-upload-spinner" />
          <div className="video-upload-text">
            <strong>📤 Uploading & Syncing Video to Classroom... {uploadProgress}%</strong>
            <span>"{uploadFileName}" is uploading to server so all students can watch and sync with you.</span>
          </div>
          <div className="video-upload-bar-track">
            <div className="video-upload-bar-fill" style={{ width: `${uploadProgress}%` }} />
          </div>
        </div>
      )}

      {/* Upload Success Banner */}
      {uploadSuccessBanner && (
        <div className="video-sync-success-banner">
          <span>✅ Local video "{videoFileName}" uploaded and synchronized with all students in the room!</span>
        </div>
      )}

      {/* Top Controls Bar */}
      <div className="video-player-header">
        <div className="video-title-group">
          <h3>
            <span>🎬</span>
            <span>Lecture Video & Watch Party</span>
          </h3>
          <span className={`video-source-pill ${mediaType}`}>
            {mediaType === 'youtube' ? '▶ YouTube Stream' : mediaType === 'direct' ? '📽️ HTML5 Video' : '📁 Video Ready'}
          </span>
          {videoFileName && (
            <span style={{ fontSize: '0.78rem', color: isLight ? '#475569' : '#94a3b8' }}>
              📄 {videoFileName}
            </span>
          )}
        </div>

        <div className="video-header-actions">
          {/* Pin Doubt Action - Available for both Teacher and Students */}
          {(videoSrc || ytVideoId) && (
            <button
              type="button"
              className="btn-pin-doubt-action"
              onClick={handleOpenPinModal}
              title="Pin doubt at current video timestamp"
            >
              <span>📍 Pin Doubt ({formatVideoTime(currentTime)})</span>
            </button>
          )}

          {/* Teacher Alone can change YouTube link */}
          {isInstructor && (
            <button
              type="button"
              className="btn-change-yt-action"
              onClick={() => {
                setYtError('');
                setIsChangeModalOpen(true);
              }}
              title="Change YouTube link or video for the classroom"
            >
              <span>🎬 Change YouTube Video</span>
            </button>
          )}

          {/* Local Video Upload - Accessible to both Teacher and Students */}
          <label
            className="btn-video-action"
            style={{ cursor: isUploadingVideo ? 'wait' : 'pointer' }}
            title={isInstructor ? "Upload an MP4 or WebM video file to stream to students" : "Upload an MP4 or WebM video file to stream to teacher and class"}
          >
            {isUploadingVideo ? `⏳ Uploading (${uploadProgress}%)` : '📁 Upload Local Video'}
            <input
              type="file"
              accept="video/mp4,video/webm,video/ogg,video/quicktime,video/x-matroska"
              style={{ display: 'none' }}
              disabled={isUploadingVideo}
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) handleLocalVideoFile(file);
                e.target.value = '';
              }}
            />
          </label>

          {/* Student Sync Indicator */}
          {!isInstructor && (videoSrc || ytVideoId) && (
            <span className="student-synced-pill" title="Playback is synchronized with teacher">
              🟢 Synced with Teacher
            </span>
          )}
        </div>
      </div>

      {/* Frame Container */}
      <div
        className={`video-frame-container ${isLight ? 'light-mode' : ''}`}
        style={isLight && (!ytVideoId && !videoSrc) ? {
          background: '#ffffff',
          backgroundColor: '#ffffff',
          backgroundImage: 'none',
          borderColor: 'rgba(8, 145, 178, 0.35)',
          boxShadow: '0 8px 30px rgba(8, 145, 178, 0.08)'
        } : undefined}
      >
        {!ytVideoId && !videoSrc ? (
          /* Student Waiting Screen vs Instructor Upload/Paste Dropzone */
          !isInstructor ? (
            <div
              className={`video-student-waiting-box ${isDragging ? 'dragging' : ''} ${isLight ? 'light-mode' : ''}`}
              style={isLight ? {
                background: '#ffffff',
                backgroundColor: '#ffffff',
                backgroundImage: 'none',
                borderColor: '#38bdf8',
                boxShadow: '0 4px 25px rgba(56, 189, 248, 0.08)'
              } : undefined}
              onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
              onDragLeave={() => setIsDragging(false)}
              onDrop={(e) => {
                e.preventDefault();
                setIsDragging(false);
                const file = e.dataTransfer.files?.[0];
                if (file && (file.type.startsWith('video/') || file.name.match(/\.(mp4|webm|ogg|mkv|mov)$/i))) {
                  handleLocalVideoFile(file);
                }
              }}
            >
              <div className="dropzone-inner">
                <span className="waiting-box-icon" style={{ fontSize: '3rem' }}>⏳</span>
                <h3
                  className={`waiting-box-title ${isLight ? 'light-mode' : ''}`}
                  style={isLight ? { color: '#042f2e' } : undefined}
                >
                  Waiting for Teacher to Start Video
                </h3>
                <p
                  className={`waiting-box-desc ${isLight ? 'light-mode' : ''}`}
                  style={isLight ? { color: '#334155' } : undefined}
                >
                  The instructor has not started a video lecture yet. Or you can upload and share a local video (MP4 / WebM) with the teacher and class below:
                </p>

                {/* Student Local Video Upload Button - Local Video Only, No YouTube */}
                <label className="btn-browse-video" style={{ cursor: isUploadingVideo ? 'wait' : 'pointer', margin: '8px 0' }}>
                  {isUploadingVideo ? `⏳ Uploading (${uploadProgress}%)` : '📁 Share Local Video with Class'}
                  <input
                    type="file"
                    accept="video/mp4,video/webm,video/ogg,video/quicktime,video/x-matroska"
                    style={{ display: 'none' }}
                    disabled={isUploadingVideo}
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (file) handleLocalVideoFile(file);
                      e.target.value = '';
                    }}
                  />
                </label>

                <div
                  className={`waiting-box-pill ${isLight ? 'light-mode' : ''}`}
                  style={isLight ? { background: '#ecfdf5', borderColor: '#10b981', color: '#047857' } : undefined}
                >
                  <span>🟢 Connected to Class</span>
                </div>
              </div>
            </div>
          ) : (
            /* Teacher Drag & Drop Upload Zone */
            <div
              className={`video-dropzone-box ${isDragging ? 'dragging' : ''} ${isLight ? 'light-mode' : ''}`}
              style={isLight ? {
                background: '#ffffff',
                backgroundColor: '#ffffff',
                backgroundImage: 'none',
                borderColor: 'rgba(8, 145, 178, 0.45)',
                boxShadow: '0 4px 25px rgba(8, 145, 178, 0.08)'
              } : undefined}
              onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
              onDragLeave={() => setIsDragging(false)}
              onDrop={(e) => {
                e.preventDefault();
                setIsDragging(false);
                const file = e.dataTransfer.files?.[0];
                if (file && (file.type.startsWith('video/') || file.name.match(/\.(mp4|webm|ogg|mkv|mov)$/i))) {
                  handleLocalVideoFile(file);
                }
              }}
            >
              <div className="dropzone-inner">
                <span style={{ fontSize: '3.2rem' }}>🎬</span>
                <h3 style={isLight ? { color: '#042f2e' } : undefined}>Drag & Drop Lecture Video Here</h3>
                <p style={isLight ? { color: '#334155' } : undefined}>Drag any MP4 or WebM video file from your computer or click to browse (Syncs to all students)</p>
                
                <label className="btn-browse-video" style={{ cursor: isUploadingVideo ? 'wait' : 'pointer' }}>
                  {isUploadingVideo ? `⏳ Uploading (${uploadProgress}%)` : '📁 Browse Local Video File'}
                  <input
                    type="file"
                    accept="video/mp4,video/webm,video/ogg,video/quicktime,video/x-matroska"
                    style={{ display: 'none' }}
                    disabled={isUploadingVideo}
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (file) handleLocalVideoFile(file);
                      e.target.value = '';
                    }}
                  />
                </label>

                <div className="dropzone-divider">
                  <span>OR PASTE YOUTUBE VIDEO LINK</span>
                </div>

                <form onSubmit={handleUpdateMedia} className="dropzone-yt-form">
                  <input
                    type="text"
                    placeholder="e.g. https://www.youtube.com/watch?v=... or youtu.be/..."
                    value={inputUrl}
                    onChange={(e) => setInputUrl(e.target.value)}
                    className="dropzone-yt-input"
                  />
                  <button type="submit" className="dropzone-yt-btn">
                    ▶ Load YouTube
                  </button>
                </form>
              </div>
            </div>
          )
        ) : mediaType === 'youtube' && ytVideoId ? (
          <div>
            <div className="youtube-iframe-wrapper">
              <div ref={ytContainerRef} className="youtube-player-mount-point" />
            </div>

            {/* Host & Student Sync Bar for YouTube */}
            <div className="youtube-sync-controller">
              <div className="youtube-sync-title">
                <span>🔴 YouTube Watch Party Room</span>
                <span style={{ fontSize: '0.72rem', color: isLight ? '#475569' : '#94a3b8' }}>
                  {isInstructor ? '(You have Host Sync controls)' : '(🟢 Synced with Teacher)'}
                </span>
              </div>
              <div className="youtube-sync-btns" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <button
                  type="button"
                  className="btn-pin-doubt-action"
                  onClick={handleOpenPinModal}
                  style={{
                    background: 'linear-gradient(135deg, #f59e0b 0%, #d97706 100%)',
                    color: '#fff',
                    border: 'none',
                    padding: '6px 14px',
                    borderRadius: 8,
                    fontWeight: 700,
                    fontSize: '0.78rem',
                    cursor: 'pointer',
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 6
                  }}
                  title="Ask a doubt or question at this video moment"
                >
                  📍 Pin Doubt ({formatVideoTime(currentTime)})
                </button>
                {isInstructor && (
                  <>
                    <button
                      type="button"
                      className="btn-yt-sync"
                      onClick={() => {
                        setYtError('');
                        setIsChangeModalOpen(true);
                      }}
                      style={{
                        background: 'linear-gradient(135deg, #ef4444 0%, #b91c1c 100%)',
                        border: 'none',
                        fontWeight: 700,
                        color: '#fff'
                      }}
                      title="Paste a new YouTube video link to change playing video"
                    >
                      🔗 Change Video
                    </button>
                    <button type="button" className="btn-yt-sync" onClick={syncHostYtPlay} title="Force Play on all student screens">
                      ▶ Force Sync Play
                    </button>
                    <button type="button" className="btn-yt-sync" onClick={syncHostYtPause} title="Force Pause on all student screens">
                      ⏸ Force Sync Pause
                    </button>
                  </>
                )}
              </div>
            </div>
          </div>
        ) : (
          <div>
            <video
              ref={videoRef}
              src={videoSrc}
              className="html5-video-player"
              controls
              onPlay={handlePlay}
              onPause={handlePause}
              onSeeked={handleSeek}
              onTimeUpdate={handleTimeUpdate}
              onLoadedMetadata={handleLoadedMetadata}
            />

            {/* Direct HTML5 Controller Bar */}
            <div className="youtube-sync-controller">
              <div className="youtube-sync-title">
                <span>📽️ Local Classroom Video</span>
                <span style={{ fontSize: '0.72rem', color: isLight ? '#475569' : '#94a3b8' }}>
                  {isInstructor ? '(You have Host Sync controls)' : '(🟢 Synced with Teacher)'}
                </span>
              </div>
              <div className="youtube-sync-btns" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <button
                  type="button"
                  className="btn-pin-doubt-action"
                  onClick={handleOpenPinModal}
                  style={{
                    background: 'linear-gradient(135deg, #f59e0b 0%, #d97706 100%)',
                    color: '#fff',
                    border: 'none',
                    padding: '6px 14px',
                    borderRadius: 8,
                    fontWeight: 700,
                    fontSize: '0.78rem',
                    cursor: 'pointer',
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 6
                  }}
                  title="Ask a doubt or question at this video moment"
                >
                  📍 Pin Doubt ({formatVideoTime(currentTime)})
                </button>
                {isInstructor && (
                  <>
                    <button
                      type="button"
                      className="btn-yt-sync"
                      onClick={() => {
                        if (videoRef.current) {
                          videoRef.current.play().catch(() => {});
                          const cleanRoom = String(roomId || '').replace(/[^a-zA-Z0-9_-]/g, '').trim();
                          socket.emit('video-state-change', { roomId: cleanRoom, type: 'play', timestamp: videoRef.current.currentTime, isInstructor: true });
                        }
                      }}
                      title="Force Play on all student screens"
                    >
                      ▶ Force Sync Play
                    </button>
                    <button
                      type="button"
                      className="btn-yt-sync"
                      onClick={() => {
                        if (videoRef.current) {
                          videoRef.current.pause();
                          const cleanRoom = String(roomId || '').replace(/[^a-zA-Z0-9_-]/g, '').trim();
                          socket.emit('video-state-change', { roomId: cleanRoom, type: 'pause', timestamp: videoRef.current.currentTime, isInstructor: true });
                        }
                      }}
                      title="Force Pause on all student screens"
                    >
                      ⏸ Force Sync Pause
                    </button>
                    <button
                      type="button"
                      className="btn-yt-sync"
                      onClick={() => {
                        setYtError('');
                        setIsChangeModalOpen(true);
                      }}
                      style={{
                        background: 'rgba(239, 68, 68, 0.25)',
                        borderColor: '#ef4444',
                        color: '#f87171'
                      }}
                      title="Switch to YouTube Video"
                    >
                      🎬 Switch to YouTube
                    </button>
                  </>
                )}
              </div>
            </div>

            {/* Timeline Annotations & Doubt Pinning */}
            <TimelineOverlay currentTime={currentTime} duration={duration} roomId={roomId} />
          </div>
        )}

        {/* Timeline & Pinned Doubts Navigation (Works for both YouTube & MP4) */}
        {(videoSrc || ytVideoId) && duration > 0 && (
          <div className="video-timeline-doubts-bar">
            <div className="timeline-track-wrap">
              <div className="timeline-time-display">
                <span>⏱️ {formatVideoTime(currentTime)} / {formatVideoTime(duration)}</span>
                <span className="timeline-pins-count">
                  📍 {videoDoubts.length} {videoDoubts.length === 1 ? 'Doubt Pinned' : 'Doubts Pinned'}
                </span>
              </div>
              <div
                className="timeline-track-progress-bar"
                onClick={(e) => {
                  const rect = e.currentTarget.getBoundingClientRect();
                  const clickX = e.clientX - rect.left;
                  const pct = Math.max(0, Math.min(1, clickX / rect.width));
                  seekToTimestamp(pct * duration);
                }}
                title="Click on timeline to seek video"
              >
                <div
                  className="timeline-progress-fill"
                  style={{ width: `${Math.min(100, Math.max(0, (currentTime / duration) * 100))}%` }}
                />
                {videoDoubts.map((d) => {
                  const leftPct = Math.min(100, Math.max(0, (d.videoTimestamp / duration) * 100));
                  return (
                    <button
                      key={d.id}
                      type="button"
                      className="timeline-pin-marker"
                      style={{ left: `${leftPct}%` }}
                      onClick={(e) => {
                        e.stopPropagation();
                        seekToTimestamp(d.videoTimestamp);
                      }}
                      title={`📍 ${d.videoTimeFormatted || formatVideoTime(d.videoTimestamp)} - ${d.senderName}: "${d.text}" (Click to seek)`}
                    >
                      <span className="timeline-pin-icon">📍</span>
                    </button>
                  );
                })}
              </div>
            </div>

            {videoDoubts.length > 0 && (
              <div className="video-pinned-doubts-chips">
                <span className="video-chips-title">Doubts:</span>
                {videoDoubts.map((d) => (
                  <button
                    key={d.id}
                    type="button"
                    className="video-doubt-chip-btn"
                    onClick={() => seekToTimestamp(d.videoTimestamp)}
                    title="Click to seek video to this doubt"
                  >
                    <span className="chip-time">▶ {d.videoTimeFormatted || formatVideoTime(d.videoTimestamp)}</span>
                    <span className="chip-sender">{d.senderName}:</span>
                    <span className="chip-text">
                      {d.text && d.text.length > 25 ? d.text.substring(0, 25) + '…' : d.text}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Change YouTube Video Modal (Instructor Only) */}
      {isChangeModalOpen && isInstructor && (
        <div className="video-pin-modal-backdrop" onClick={() => setIsChangeModalOpen(false)}>
          <div className="video-pin-modal-card video-change-modal-card" onClick={(e) => e.stopPropagation()}>
            <div className="video-pin-modal-header">
              <div className="video-pin-title">
                <h4 style={{ color: '#dc2626', display: 'flex', alignItems: 'center', gap: 8, margin: 0 }}>
                  <span>🎬</span> Change YouTube Video for Classroom
                </h4>
                <span className="video-pin-sub">
                  Paste a new YouTube video link to instantly switch and play on all student screens.
                </span>
              </div>
              <button
                type="button"
                className="video-pin-close-btn"
                onClick={() => setIsChangeModalOpen(false)}
                title="Close"
              >
                ✕
              </button>
            </div>

            <form onSubmit={handleModalSubmitNewYt} style={{ display: 'flex', flexDirection: 'column', gap: 14, marginTop: 4 }}>
              <div className="change-yt-input-group">
                <label style={{ fontSize: '0.85rem', fontWeight: 600, marginBottom: 6, display: 'block', color: isLight ? '#0f172a' : '#cbd5e1' }}>
                  New YouTube Video Link / URL:
                </label>
                <div style={{ display: 'flex', gap: 8 }}>
                  <input
                    type="text"
                    className="dropzone-yt-input"
                    placeholder="e.g. https://www.youtube.com/watch?v=... or youtu.be/..."
                    value={newYtUrlInput}
                    onChange={(e) => {
                      setNewYtUrlInput(e.target.value);
                      setYtError('');
                    }}
                    autoFocus
                  />
                  <button type="submit" className="dropzone-yt-btn" style={{ whiteSpace: 'nowrap' }}>
                    ▶ Change Video
                  </button>
                </div>
                {ytError && (
                  <div style={{ color: '#ef4444', fontSize: '0.82rem', marginTop: 6, display: 'flex', alignItems: 'center', gap: 4 }}>
                    <span>⚠️</span> {ytError}
                  </div>
                )}
              </div>

              <div className="video-pin-actions" style={{ marginTop: 8 }}>
                <button
                  type="button"
                  className="btn-cancel-pin"
                  onClick={() => setIsChangeModalOpen(false)}
                >
                  Cancel
                </button>
                <button type="submit" className="btn-confirm-pin" style={{ background: '#dc2626' }}>
                  ▶ Update & Sync Video
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Pin Doubt Modal Dialog */}
      {isPinModalOpen && (
        <div className="video-pin-modal-backdrop" onClick={() => setIsPinModalOpen(false)}>
          <div className="video-pin-modal-card" onClick={(e) => e.stopPropagation()}>
            <div className="video-pin-modal-header">
              <div className="video-pin-title">
                <h4>📍 Pin Doubt at {formatVideoTime(capturedTimestamp)}</h4>
                <span className="video-pin-sub">
                  Pin your doubt at this exact video moment so the instructor and peers can review it.
                </span>
              </div>
              <button
                type="button"
                className="video-pin-close-btn"
                onClick={() => setIsPinModalOpen(false)}
                title="Close"
              >
                ✕
              </button>
            </div>

            {/* Quick Suggestion Chips */}
            <div className="video-pin-chips-row">
              {[
                'Explain this formula',
                'Please repeat this step',
                'Why is this method used?',
                'Code syntax question',
                'Could not understand this part'
              ].map((chip, idx) => (
                <button
                  key={idx}
                  type="button"
                  className="video-pin-chip"
                  onClick={() => setDoubtText(chip)}
                >
                  {chip}
                </button>
              ))}
            </div>

            <form onSubmit={handleSubmitPinDoubt}>
              <textarea
                className="video-pin-textarea"
                rows={3}
                placeholder="Type your question or doubt here..."
                value={doubtText}
                onChange={(e) => setDoubtText(e.target.value)}
                autoFocus
              />

              <div className="video-pin-actions">
                <button
                  type="button"
                  className="btn-cancel-pin"
                  onClick={() => setIsPinModalOpen(false)}
                >
                  Cancel
                </button>
                <button type="submit" className="btn-confirm-pin">
                  📌 Pin Doubt to Video
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};

export default VideoPlayer;
