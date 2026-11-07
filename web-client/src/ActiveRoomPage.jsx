import React, { useState, useEffect, useRef } from 'react';
import { jsPDF } from 'jspdf';
import { Send } from 'lucide-react';
import Peer from 'simple-peer';
import './ActiveRoomPage.css';
import WhiteboardCanvas from './WhiteboardCanvas';
import { socket } from './socket';
import VideoPlayer from './components/VideoPlayer';
// Remote peer video & audio component with dedicated audio element and speaking indicator
const RemoteVideo = ({ peer, peerInfo, mediaState, isHandRaised = false }) => {
  const videoRef = useRef(null);
  const audioRef = useRef(null);
  const [audioBlocked, setAudioBlocked] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [peerVolume, setPeerVolume] = useState(100);
  const [hasVideoFrame, setHasVideoFrame] = useState(false);

  const [streamTracks, setStreamTracks] = useState({ hasVideo: false, hasAudio: false });

  const audioCtxRef = useRef(null);
  const sourceNodeRef = useRef(null);
  const currentVideoTrackIdRef = useRef(null);
  const currentAudioTrackIdRef = useRef(null);

  // Synchronize remote video and audio tracks directly from native WebRTC receivers and simple-peer streams
  const syncRemoteMedia = () => {
    if (!peer) return;

    let videoTrack = null;
    let audioTrack = null;

    // 1. Simple-peer _remoteStreams and streams (verified active decoded media)
    const allStreams = [...(peer._remoteStreams || []), ...(peer.streams || [])];
    for (const s of allStreams) {
      if (!videoTrack && typeof s.getVideoTracks === 'function') {
        const vt = s.getVideoTracks().find(t => t.readyState !== 'ended');
        if (vt) videoTrack = vt;
      }
      if (!audioTrack && typeof s.getAudioTracks === 'function') {
        const at = s.getAudioTracks().find(t => t.readyState !== 'ended');
        if (at) audioTrack = at;
      }
    }

    // 2. Simple-peer _remoteTracks
    if (!videoTrack && Array.isArray(peer._remoteTracks)) {
      const item = peer._remoteTracks.find(t => t.track && t.track.kind === 'video' && t.track.readyState !== 'ended');
      if (item) videoTrack = item.track;
    }
    if (!audioTrack && Array.isArray(peer._remoteTracks)) {
      const item = peer._remoteTracks.find(t => t.track && t.track.kind === 'audio' && t.track.readyState !== 'ended');
      if (item) audioTrack = item.track;
    }

    // 3. Native RTCPeerConnection receivers (direct WebRTC hardware pipe fallback)
    if (peer._pc && typeof peer._pc.getReceivers === 'function') {
      try {
        const receivers = peer._pc.getReceivers();
        if (!videoTrack) {
          const vr = receivers.find(r => r.track && r.track.kind === 'video' && r.track.readyState !== 'ended');
          if (vr) videoTrack = vr.track;
        }
        if (!audioTrack) {
          const ar = receivers.find(r => r.track && r.track.kind === 'audio' && r.track.readyState !== 'ended');
          if (ar) audioTrack = ar.track;
        }
      } catch (e) {}
    }

    setStreamTracks({
      hasVideo: Boolean(videoTrack && videoTrack.readyState === 'live'),
      hasAudio: Boolean(audioTrack && audioTrack.readyState === 'live')
    });

    // 4. Attach Live Video Track to <video> element
    if (videoTrack && videoRef.current) {
      videoTrack.enabled = true;
      if (!videoTrack.muted) {
        setHasVideoFrame(true);
      }
      videoTrack.onunmute = () => {
        setHasVideoFrame(true);
        if (videoRef.current) {
          videoRef.current.play().catch(() => {});
        }
      };
      if (currentVideoTrackIdRef.current !== videoTrack.id || !videoRef.current.srcObject) {
        currentVideoTrackIdRef.current = videoTrack.id;
        const vStream = new MediaStream([videoTrack]);
        videoRef.current.srcObject = vStream;
      }
      // Ensure mobile / WebKit / Blink video autoplay requirements
      videoRef.current.defaultMuted = true;
      videoRef.current.muted = true;
      videoRef.current.playsInline = true;
      videoRef.current.setAttribute('playsinline', '');
      videoRef.current.setAttribute('webkit-playsinline', '');
      const vp = videoRef.current.play();
      if (vp !== undefined) {
        vp.then(() => setHasVideoFrame(true)).catch(() => {});
      }
    }

    // 5. Attach Live Audio Track to dedicated <audio> element (strictly enforce remote mute)
    if (audioTrack && audioRef.current) {
      const isPeerMuted = (mediaState && mediaState.micOn === false);
      audioTrack.enabled = !isPeerMuted;
      audioTrack.onunmute = () => {
        if (mediaState?.micOn !== false) {
          audioTrack.enabled = true;
          if (audioRef.current) {
            audioRef.current.muted = false;
            audioRef.current.volume = Math.max(0, Math.min(1, peerVolume / 100));
            audioRef.current.play().then(() => setAudioBlocked(false)).catch(() => {});
          }
        }
      };
      if (currentAudioTrackIdRef.current !== audioTrack.id || !audioRef.current.srcObject) {
        currentAudioTrackIdRef.current = audioTrack.id;
        const aStream = new MediaStream([audioTrack]);
        audioRef.current.srcObject = aStream;
      }
      if (isPeerMuted) {
        audioRef.current.muted = true;
        audioRef.current.volume = 0;
        audioRef.current.pause();
      } else {
        audioRef.current.muted = false;
        audioRef.current.volume = Math.max(0, Math.min(1, peerVolume / 100));
        try {
          const prefSpeaker = localStorage.getItem('synclearn_preferred_speaker');
          if (prefSpeaker && prefSpeaker !== 'default' && typeof audioRef.current.setSinkId === 'function') {
            audioRef.current.setSinkId(prefSpeaker).catch(() => {});
          }
        } catch (e) {}
        const ap = audioRef.current.play();
        if (ap !== undefined) {
          ap.then(() => setAudioBlocked(false)).catch(() => {});
        }
      }
    }

    // 6. Web Audio Analyser for Speaking Level Indicator
    if (audioTrack && audioTrack.readyState === 'live') {
      try {
        const AudioCtx = window.AudioContext || window.webkitAudioContext;
        if (AudioCtx) {
          if (!audioCtxRef.current || audioCtxRef.current.state === 'closed') {
            audioCtxRef.current = (window.__synclearnGlobalAudioCtx && window.__synclearnGlobalAudioCtx.state !== 'closed')
              ? window.__synclearnGlobalAudioCtx
              : new AudioCtx();
          }
          const ctx = audioCtxRef.current;
          if (ctx.state === 'suspended') {
            ctx.resume().catch(() => {});
          }

          if (!sourceNodeRef.current) {
            const analyserStream = new MediaStream([audioTrack]);
            const analyser = ctx.createAnalyser();
            analyser.fftSize = 128;
            analyser.smoothingTimeConstant = 0.3;

            const source = ctx.createMediaStreamSource(analyserStream);
            sourceNodeRef.current = source;
            source.connect(analyser);

            const dataArray = new Uint8Array(analyser.frequencyBinCount);
            const detectVoice = () => {
              if (analyser) {
                analyser.getByteFrequencyData(dataArray);
                let sum = 0;
                for (let i = 0; i < dataArray.length; i++) sum += dataArray[i];
                const avg = sum / dataArray.length;
                setIsSpeaking(avg > 18);
              }
              animId = requestAnimationFrame(detectVoice);
            };
            detectVoice();
          }
        }
      } catch (e) {
        console.warn('Voice level analyser notice:', e);
      }
    }
  };

  let animId;
  useEffect(() => {
    syncRemoteMedia();

    // Listen to SimplePeer events
    peer.on('stream', syncRemoteMedia);
    peer.on('track', syncRemoteMedia);
    peer.on('connect', syncRemoteMedia);

    // Listen directly to native RTCPeerConnection events
    const pc = peer._pc;
    if (pc) {
      pc.addEventListener('track', syncRemoteMedia);
      pc.addEventListener('connectionstatechange', syncRemoteMedia);
      pc.addEventListener('iceconnectionstatechange', syncRemoteMedia);
    }

    // Periodic safety sync (checks every 800ms)
    const interval = setInterval(syncRemoteMedia, 800);

    return () => {
      peer.removeListener('stream', syncRemoteMedia);
      peer.removeListener('track', syncRemoteMedia);
      peer.removeListener('connect', syncRemoteMedia);
      if (pc) {
        pc.removeEventListener('track', syncRemoteMedia);
        pc.removeEventListener('connectionstatechange', syncRemoteMedia);
        pc.removeEventListener('iceconnectionstatechange', syncRemoteMedia);
      }
      clearInterval(interval);
      if (animId) cancelAnimationFrame(animId);
      if (sourceNodeRef.current) {
        try { sourceNodeRef.current.disconnect(); } catch (e) {}
        sourceNodeRef.current = null;
      }
    };
  }, [peer]);

  // Adjust volume & mute state dynamically
  useEffect(() => {
    const vol = Math.max(0, Math.min(1, peerVolume / 100));
    if (audioRef.current) {
      if (mediaState && mediaState.micOn === false) {
        audioRef.current.muted = true;
        audioRef.current.volume = 0;
        audioRef.current.pause();
      } else {
        audioRef.current.muted = false;
        audioRef.current.volume = vol;
        audioRef.current.play().catch(() => {});
      }
    }
  }, [peerVolume, mediaState?.micOn]);

  // If mediaState is received from socket use it; otherwise fallback to whether stream actually has live track
  const isVideoOn = mediaState !== undefined ? Boolean(mediaState?.videoOn) : streamTracks.hasVideo;
  const isMicOn = mediaState !== undefined ? Boolean(mediaState?.micOn) : streamTracks.hasAudio;
  const isInstructorPeer = peerInfo?.userRole === 'instructor';
  const peerName = peerInfo?.userName || (isInstructorPeer ? 'Instructor' : 'Peer');

  // Reactive watcher for peer microphone state changes: re-trigger audio element play immediately
  useEffect(() => {
    if (isMicOn) {
      syncRemoteMedia();
      if (audioRef.current) {
        if (audioRef.current.srcObject) {
          try {
            audioRef.current.srcObject.getAudioTracks().forEach(t => {
              t.enabled = true;
            });
          } catch (e) {}
        }
        audioRef.current.muted = false;
        audioRef.current.volume = Math.max(0, Math.min(1, peerVolume / 100));
        const p = audioRef.current.play();
        if (p !== undefined) {
          p.then(() => setAudioBlocked(false)).catch(err => {
            console.warn('Microphone re-activation waiting for tap:', err);
            setAudioBlocked(true);
          });
        }
      }
      try {
        if (window.__synclearnGlobalAudioCtx && window.__synclearnGlobalAudioCtx.state === 'suspended') {
          window.__synclearnGlobalAudioCtx.resume().catch(() => {});
        }
      } catch (e) {}
      if (audioCtxRef.current && audioCtxRef.current.state === 'suspended') {
        audioCtxRef.current.resume().catch(() => {});
      }
    } else {
      if (audioRef.current) {
        audioRef.current.muted = true;
        audioRef.current.volume = 0;
        audioRef.current.pause();
      }
    }
  }, [isMicOn, mediaState, peerVolume]);

  const handleUnblockAudio = () => {
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (AudioCtx) {
        if (!window.__synclearnGlobalAudioCtx || window.__synclearnGlobalAudioCtx.state === 'closed') {
          window.__synclearnGlobalAudioCtx = new AudioCtx();
        }
        const gCtx = window.__synclearnGlobalAudioCtx;
        if (gCtx.state === 'suspended') {
          gCtx.resume().catch(() => {});
        }
        try {
          const silentBuf = gCtx.createBuffer(1, 1, 22050);
          const bSource = gCtx.createBufferSource();
          bSource.buffer = silentBuf;
          bSource.connect(gCtx.destination);
          bSource.start(0);
        } catch (be) {}
      }
    } catch (e) {}

    if (audioCtxRef.current && audioCtxRef.current.state === 'suspended') {
      audioCtxRef.current.resume().catch(() => {});
    }
    if (audioRef.current) {
      audioRef.current.muted = false;
      audioRef.current.volume = Math.max(0, Math.min(1, peerVolume / 100));
      audioRef.current.play()
        .then(() => setAudioBlocked(false))
        .catch(err => console.error('Play error:', err));
    }
    if (videoRef.current) {
      videoRef.current.play().catch(() => {});
    }
    setAudioBlocked(false);
  };

  // Continuous user interaction unblocker for mobile touch and desktop click
  useEffect(() => {
    const unlockAudio = () => {
      try {
        const AudioCtx = window.AudioContext || window.webkitAudioContext;
        if (AudioCtx) {
          if (!window.__synclearnGlobalAudioCtx || window.__synclearnGlobalAudioCtx.state === 'closed') {
            window.__synclearnGlobalAudioCtx = new AudioCtx();
          }
          const gCtx = window.__synclearnGlobalAudioCtx;
          if (gCtx.state === 'suspended') {
            gCtx.resume().catch(() => {});
          }
          // Silent buffer unlocker for mobile devices
          try {
            const silentBuf = gCtx.createBuffer(1, 1, 22050);
            const bSource = gCtx.createBufferSource();
            bSource.buffer = silentBuf;
            bSource.connect(gCtx.destination);
            bSource.start(0);
          } catch(be) {}
        }
      } catch (e) {}

      if (audioCtxRef.current && audioCtxRef.current.state === 'suspended') {
        audioCtxRef.current.resume().then(() => setAudioBlocked(false)).catch(() => {});
      }
      if (audioRef.current && audioRef.current.srcObject) {
        audioRef.current.muted = false;
        audioRef.current.volume = Math.max(0, Math.min(1, peerVolume / 100));
        audioRef.current.play()
          .then(() => setAudioBlocked(false))
          .catch(() => {});
      }
      if (videoRef.current && videoRef.current.srcObject) {
        videoRef.current.play().catch(() => {});
      }
    };

    window.addEventListener('click', unlockAudio);
    window.addEventListener('touchstart', unlockAudio, { passive: true });
    window.addEventListener('touchend', unlockAudio, { passive: true });
    window.addEventListener('pointerdown', unlockAudio, { passive: true });
    window.addEventListener('keydown', unlockAudio);

    return () => {
      window.removeEventListener('click', unlockAudio);
      window.removeEventListener('touchstart', unlockAudio);
      window.removeEventListener('touchend', unlockAudio);
      window.removeEventListener('pointerdown', unlockAudio);
      window.removeEventListener('keydown', unlockAudio);
    };
  }, [peerVolume]);

  // Ensure video element plays and attaches live track when video is toggled on or mediaState arrives
  useEffect(() => {
    if (isVideoOn) {
      syncRemoteMedia();
    } else {
      setHasVideoFrame(false);
    }
  }, [isVideoOn, mediaState]);

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%' }} className={isSpeaking ? 'peer-speaking-highlight' : ''}>
      {/* ── Video Element (Always muted, video only, never blocks audio) ── */}
      <video
        autoPlay
        playsInline
        muted
        ref={videoRef}
        onLoadedMetadata={() => setHasVideoFrame(true)}
        onLoadedData={() => setHasVideoFrame(true)}
        onCanPlay={() => setHasVideoFrame(true)}
        onPlaying={() => setHasVideoFrame(true)}
        onTimeUpdate={() => {
          if (videoRef.current && videoRef.current.videoWidth > 0) setHasVideoFrame(true);
        }}
        onError={() => setHasVideoFrame(false)}
        className="video-element"
        style={{
          width: '100%',
          height: '100%',
          objectFit: 'cover',
          display: isVideoOn ? 'block' : 'none',
          opacity: hasVideoFrame ? 1 : 0,
          transition: 'opacity 0.2s ease'
        }}
      />
      {/* ── Dedicated Remote Audio Element ── */}
      <audio
        autoPlay
        playsInline
        ref={audioRef}
        onLoadedMetadata={() => {
          if (audioRef.current) {
            audioRef.current.muted = false;
            audioRef.current.play().then(() => setAudioBlocked(false)).catch(() => {});
          }
        }}
        onCanPlay={() => {
          if (audioRef.current) {
            audioRef.current.muted = false;
            audioRef.current.play().then(() => setAudioBlocked(false)).catch(() => {});
          }
        }}
      />

      {/* ── Camera Off or Waiting Avatar Placeholder (Image 4) ── */}
      {(!isVideoOn || !hasVideoFrame) && (
        <div
          className="video-camera-off-container"
          style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 10,
            zIndex: 2,
            background: 'radial-gradient(circle at center, #1e293b 0%, #0f172a 100%)'
          }}
        >
          <div
            className="video-camera-off-circle"
            style={{
              width: 76,
              height: 76,
              borderRadius: '50%',
              background: isInstructorPeer ? 'linear-gradient(135deg, #4f46e5 0%, #7c3aed 100%)' : 'linear-gradient(135deg, #0284c7 0%, #0369a1 100%)',
              color: '#ffffff',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: '2rem',
              fontWeight: 800,
              boxShadow: '0 4px 20px rgba(0,0,0,0.4)',
              border: '2.5px solid rgba(56, 189, 248, 0.4)'
            }}
          >
            {(peerName || 'U').charAt(0).toUpperCase()}
          </div>
          {isVideoOn && !hasVideoFrame && (
            <span style={{ fontSize: '0.75rem', color: '#38bdf8', fontWeight: 600, display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ width: 10, height: 10, border: '2px solid #38bdf8', borderTopColor: 'transparent', borderRadius: '50%', display: 'inline-block', animation: 'spin 1s linear infinite' }} />
              Connecting video...
            </span>
          )}
        </div>
      )}

      {/* ── Bottom Corner Label & Media Status (OFF / ON) ── */}
      <span className="video-label" style={{ zIndex: 20 }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {isInstructorPeer ? '👨‍🏫 ' : '🎓 '}
          <strong style={{ color: isInstructorPeer ? '#38bdf8' : 'inherit' }}>
            {peerName}
          </strong>
        </span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, flexShrink: 0 }}>
          <span
            title={isMicOn ? 'Microphone Active' : 'Microphone Muted'}
            style={{
              background: isMicOn ? 'rgba(34, 197, 94, 0.25)' : 'rgba(239, 68, 68, 0.25)',
              border: `1px solid ${isMicOn ? '#22c55e' : '#ef4444'}`,
              padding: '1px 5px',
              borderRadius: 4,
              fontSize: '0.7rem',
              fontWeight: 700,
              color: isMicOn ? '#4ade80' : '#f87171'
            }}
          >
            {isMicOn ? '🎙️ ON' : '🔇 OFF'}
          </span>
          <span
            title={isVideoOn ? 'Camera Active' : 'Camera Off'}
            style={{
              background: isVideoOn ? 'rgba(56, 189, 248, 0.25)' : 'rgba(148, 163, 184, 0.25)',
              border: `1px solid ${isVideoOn ? '#38bdf8' : '#94a3b8'}`,
              padding: '1px 5px',
              borderRadius: 4,
              fontSize: '0.7rem',
              fontWeight: 700,
              color: isVideoOn ? '#38bdf8' : '#cbd5e1'
            }}
          >
            {isVideoOn ? '📹 ON' : '🚫 OFF'}
          </span>
        </span>
      </span>

      {/* Speaking badge indicator (top-left) */}
      {isSpeaking && (
        <div style={{
          position: 'absolute',
          top: 8,
          left: 8,
          background: '#22c55e',
          color: '#fff',
          fontSize: '0.72rem',
          fontWeight: 600,
          padding: '2px 8px',
          borderRadius: '99px',
          display: 'flex',
          alignItems: 'center',
          gap: 4,
          boxShadow: '0 2px 8px rgba(34,197,94,0.4)',
          zIndex: 5
        }}>
          <span>🔊</span>
          <span>Speaking...</span>
        </div>
      )}

      {/* Hand Raised badge indicator (top-right) */}
      {isHandRaised && (
        <div style={{
          position: 'absolute',
          top: 8,
          right: 8,
          background: 'rgba(234, 88, 12, 0.95)',
          border: '1.5px solid #ffedd5',
          color: '#ffffff',
          fontSize: '0.74rem',
          fontWeight: 800,
          padding: '3px 9px',
          borderRadius: '99px',
          display: 'flex',
          alignItems: 'center',
          gap: 4,
          boxShadow: '0 0 15px rgba(249, 115, 22, 0.75)',
          zIndex: 25,
          animation: 'handBounce 1.5s ease-in-out infinite'
        }}>
          <span style={{ fontSize: '0.9rem' }}>✋</span>
          <span>Hand Raised</span>
        </div>
      )}

      {audioBlocked && (
        <button
          type="button"
          onClick={handleUnblockAudio}
          style={{
            position: 'absolute',
            top: 10,
            right: 10,
            zIndex: 30,
            background: 'linear-gradient(135deg, #16a34a 0%, #15803d 100%)',
            color: '#ffffff',
            border: '2px solid #86efac',
            borderRadius: 8,
            padding: '7px 14px',
            fontSize: '0.82rem',
            fontWeight: 800,
            cursor: 'pointer',
            boxShadow: '0 4px 15px rgba(22, 163, 74, 0.6)',
            display: 'flex',
            alignItems: 'center',
            gap: 6
          }}
        >
          🔊 Tap to Turn On Sound
        </button>
      )}
    </div>
  );
};

// ── Local User Video Card with Auto-play & Live Speaking Indicator ──
const LocalVideo = ({ stream, videoOn, isSpeaking, micOn, isBackgroundBlurred = false, isAutoFramed = false, user, onOpenSettings, isHandRaised = false }) => {
  const ref = useRef(null);

  useEffect(() => {
    if (ref.current && stream && videoOn) {
      ref.current.srcObject = stream;
      ref.current.play().catch(err => console.log('Local video play error:', err));
    }
  }, [stream, videoOn]);

  return (
    <div className={`video-card ${isSpeaking ? 'peer-speaking-highlight' : ''} ${isHandRaised ? 'hand-raised-card' : ''}`}>
      {/* ── Image 3: When camera is off, show Profile Picture ── */}
      {!videoOn ? (
        <div
          className="video-camera-off-container"
          onClick={() => onOpenSettings && onOpenSettings('account')}
          title="Click to add or change profile picture"
        >
          {user?.avatar ? (
            <img src={user.avatar} alt="Profile" className="video-camera-off-avatar-img" />
          ) : (
            <div className="video-camera-off-circle">
              {(user?.name || 'U').charAt(0).toUpperCase()}
            </div>
          )}
          <div className="video-camera-off-overlay-hint">
            📷 {user?.avatar ? 'Change Picture' : 'Add Profile Picture'}
          </div>
        </div>
      ) : (
        <video
          ref={ref}
          autoPlay
          playsInline
          muted
          className="video-element"
          style={{
            filter: isBackgroundBlurred ? 'blur(8px)' : 'none',
            transform: isAutoFramed ? 'scale(1.2)' : isBackgroundBlurred ? 'scale(1.08)' : 'none',
            transition: 'filter 0.3s ease, transform 0.3s ease'
          }}
        />
      )}
      {isBackgroundBlurred && videoOn && (
        <span style={{
          position: 'absolute',
          top: 8,
          right: 8,
          background: 'rgba(2, 132, 199, 0.85)',
          color: '#fff',
          fontSize: '0.65rem',
          fontWeight: 700,
          padding: '2px 7px',
          borderRadius: '99px',
          zIndex: 5
        }}>
          ✨ Blur On
        </span>
      )}


      {isHandRaised && (
        <span style={{
          position: 'absolute',
          top: 8,
          left: 8,
          background: 'rgba(234, 88, 12, 0.95)',
          border: '1.5px solid #ffedd5',
          color: '#ffffff',
          fontSize: '0.72rem',
          fontWeight: 800,
          padding: '2px 8px',
          borderRadius: '99px',
          display: 'flex',
          alignItems: 'center',
          gap: 4,
          boxShadow: '0 0 12px rgba(234, 88, 12, 0.75)',
          zIndex: 25,
          animation: 'handBounce 1.5s ease-in-out infinite'
        }}>
          <span>✋ Hand Raised</span>
        </span>
      )}

      <span className="video-label" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '4px 8px' }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
          {user?.role === 'instructor' ? '👨‍🏫 You (Instructor)' : '🎓 You'}
        </span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, flexShrink: 0 }}>
          <span
            style={{
              background: micOn ? 'rgba(34, 197, 94, 0.25)' : 'rgba(239, 68, 68, 0.25)',
              border: `1px solid ${micOn ? '#22c55e' : '#ef4444'}`,
              padding: '1px 5px',
              borderRadius: 4,
              fontSize: '0.7rem',
              fontWeight: 700,
              color: micOn ? '#4ade80' : '#f87171'
            }}
          >
            {micOn ? '🎙️ ON' : '🔇 OFF'}
          </span>
          <span
            style={{
              background: videoOn ? 'rgba(56, 189, 248, 0.25)' : 'rgba(148, 163, 184, 0.25)',
              border: `1px solid ${videoOn ? '#38bdf8' : '#94a3b8'}`,
              padding: '1px 5px',
              borderRadius: 4,
              fontSize: '0.7rem',
              fontWeight: 700,
              color: videoOn ? '#38bdf8' : '#cbd5e1'
            }}
          >
            {videoOn ? '📹 ON' : '🚫 OFF'}
          </span>
        </span>
      </span>
      {isSpeaking && (
        <div style={{
          position: 'absolute',
          top: 8,
          left: 8,
          background: '#22c55e',
          color: '#fff',
          fontSize: '0.72rem',
          fontWeight: 600,
          padding: '2px 8px',
          borderRadius: '99px',
          display: 'flex',
          alignItems: 'center',
          gap: 4,
          boxShadow: '0 2px 8px rgba(34,197,94,0.4)',
          zIndex: 5
        }}>
          <span>🎙️</span>
          <span>Speaking...</span>
        </div>
      )}
    </div>
  );
};

// ── Control button with label ──
const CtrlBtn = ({ onClick, title, label, icon, className = '' }) => (
  <div className="control-btn-wrap">
    <button className={`control-btn ${className}`} onClick={onClick} title={title}>
      {icon}
    </button>
    <span className="ctrl-label">{label || title}</span>
  </div>
);

// ── Clean & Extract Room ID ──
const cleanRoomId = (raw) => {
  if (!raw) return '';
  let str = String(raw).trim();
  if (str.includes('room=')) {
    try {
      const urlPart = str.includes('?') ? str.split('?')[1] : str;
      const params = new URLSearchParams(urlPart);
      const r = params.get('room');
      if (r) return r.trim();
    } catch (e) {}
  }
  return str.replace(/^https?:\/\/[^/]+\/?/i, '').replace(/[^a-zA-Z0-9_-]/g, '').trim() || str.trim();
};

// ── Synthetic Canvas Video Stream Fallback ──
// Prevents WebRTC failure when two tabs on the same PC compete for the single hardware webcam
function createFallbackStream(userName, isInstructor) {
  const canvas = document.createElement('canvas');
  canvas.width = 640;
  canvas.height = 480;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  const initials = (userName || (isInstructor ? 'Instructor' : 'Student'))
    .split(' ')
    .filter(Boolean)
    .map(w => w[0])
    .slice(0, 2)
    .join('')
    .toUpperCase() || (isInstructor ? 'INS' : 'STU');

  let step = 0;
  const drawAvatar = () => {
    step = (step + 1) % 360;
    const pulse = Math.sin((step * Math.PI) / 180) * 6;

    // Background gradient
    const grad = ctx.createLinearGradient(0, 0, 640, 480);
    grad.addColorStop(0, '#0f172a');
    grad.addColorStop(1, '#1e293b');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 640, 480);

    // Outer animated glow ring
    ctx.beginPath();
    ctx.arc(320, 210, 85 + pulse, 0, Math.PI * 2);
    ctx.fillStyle = isInstructor ? 'rgba(99, 102, 241, 0.25)' : 'rgba(16, 185, 129, 0.25)';
    ctx.fill();

    // Inner avatar circle
    ctx.beginPath();
    ctx.arc(320, 210, 70, 0, Math.PI * 2);
    ctx.fillStyle = isInstructor ? '#6366f1' : '#10b981';
    ctx.fill();
    ctx.lineWidth = 4;
    ctx.strokeStyle = '#ffffff';
    ctx.stroke();

    // Initials
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 44px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(initials, 320, 212);

    // User Name
    ctx.font = 'bold 20px sans-serif';
    ctx.fillStyle = '#f8fafc';
    ctx.fillText(userName || (isInstructor ? 'Instructor' : 'Student'), 320, 320);

    // Status subtitle
    ctx.font = '14px sans-serif';
    ctx.fillStyle = '#38bdf8';
    ctx.fillText('Virtual Video Active', 320, 350);
  };

  drawAvatar();
  const stream = canvas.captureStream ? canvas.captureStream(15) : null;
  const timer = setInterval(drawAvatar, 1000 / 15);
  if (stream) {
    const vTrack = stream.getVideoTracks()[0];
    if (vTrack) {
      vTrack._isSynthetic = true;
      const origStop = vTrack.stop.bind(vTrack);
      vTrack.stop = () => {
        clearInterval(timer);
        origStop();
      };
    }
  }
  return stream;
}

// ── Silent Web Audio Track Generator Fallback ──
// Guarantees WebRTC RTCPeerConnection ALWAYS negotiates an audio transceiver in SDP offer/answer
function createSilentAudioTrack() {
  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return null;
    const ctx = new AudioCtx();
    const osc = ctx.createOscillator();
    const dst = ctx.createMediaStreamDestination();
    const gain = ctx.createGain();
    gain.gain.value = 0; // absolute silence
    osc.connect(gain);
    gain.connect(dst);
    osc.start();
    const track = dst.stream.getAudioTracks()[0];
    if (track) {
      track.enabled = false;
      track._isSilentTrack = true;
      return track;
    }
  } catch (e) {
    console.warn('Silent audio track fallback notice:', e);
  }
  return null;
}

// ── Acquire Real Media with Automatic Audio / Synthetic Fallback ──
async function acquireMediaStream(userName, isInstructor) {
  let stream = null;
  let hasRealVideo = false;

  // 1. Try real video + audio
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: true,
      audio: true
    });
    hasRealVideo = true;
    return { stream, hasRealVideo };
  } catch (errVideo) {
    console.warn('Physical camera unavailable (may be in use or permission pending):', errVideo);
  }

  // 2. Try audio only
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (errAudio) {
    console.warn('Hardware microphone unavailable or permission denied:', errAudio);
    stream = new MediaStream();
  }

  // 2b. If stream still has no audio track, attach silent audio track so WebRTC transceiver negotiates:
  if (stream.getAudioTracks().length === 0) {
    const silentTrack = createSilentAudioTrack();
    if (silentTrack) stream.addTrack(silentTrack);
  }

  // 3. Attach fallback canvas video track ONLY if no real video track exists
  try {
    if (!hasRealVideo && stream.getVideoTracks().length === 0) {
      const canvasStream = createFallbackStream(userName, isInstructor);
      if (canvasStream) {
        const vTrack = canvasStream.getVideoTracks()[0];
        if (vTrack) {
          vTrack._isSynthetic = true;
          stream.addTrack(vTrack);
        }
      }
    }
  } catch (e) {
    console.warn('Synthetic canvas error:', e);
  }

  return { stream, hasRealVideo };
}

// ── Helpers: Coursera-style Markdown Formatter for Gemini Coach ──
const formatInlineBold = (str) => {
  if (!str) return '';
  const parts = str.split('**');
  if (parts.length === 1) return str;
  return parts.map((part, i) => (i % 2 === 1 ? <strong key={i} style={{ color: '#38bdf8' }}>{part}</strong> : part));
};

const renderFormattedAiText = (rawText) => {
  if (!rawText) return null;
  const lines = rawText.split('\n');
  return lines.map((line, idx) => {
    const trimmed = line.trim();
    if (trimmed.startsWith('```')) {
      return (
        <div key={idx} className="gemini-code-badge">
          {trimmed.replace(/```/g, '') || 'CODE BLOCK'}
        </div>
      );
    }
    if (trimmed.startsWith('### ')) {
      return <h4 key={idx} className="gemini-heading-3">{trimmed.replace('### ', '')}</h4>;
    }
    if (trimmed.startsWith('#### ')) {
      return <h5 key={idx} className="gemini-heading-4">{trimmed.replace('#### ', '')}</h5>;
    }
    if (trimmed.startsWith('> ')) {
      return (
        <blockquote key={idx} className="gemini-quote">
          {formatInlineBold(trimmed.replace('> ', ''))}
        </blockquote>
      );
    }
    if (trimmed.startsWith('• ') || trimmed.startsWith('* ') || trimmed.startsWith('- ')) {
      return (
        <div key={idx} className="gemini-bullet-item">
          <span className="gemini-bullet-dot">▸</span>
          <span>{formatInlineBold(trimmed.replace(/^[•*-]\s*/, ''))}</span>
        </div>
      );
    }
    if (/^\d+\.\s/.test(trimmed)) {
      return (
        <div key={idx} className="gemini-numbered-item">
          {formatInlineBold(trimmed)}
        </div>
      );
    }
    if (!trimmed) {
      return <div key={idx} style={{ height: '6px' }} />;
    }
    return (
      <p key={idx} className="gemini-paragraph">
        {formatInlineBold(line)}
      </p>
    );
  });
};

function ActiveRoomPage({
  roomId,
  user,
  roomHostName,
  onLeaveRoom,
  onOpenSettings,
  theme,
  onToggleTheme,
  initialMicOn = true,
  initialVideoOn = true,
  initialBlurBackground = false,
  initialStream = null,
}) {
  const isInstructor = user?.role === 'instructor';

  const [activeTab, setActiveTab]         = useState(null);
  const [micOn, setMicOn]                 = useState(initialMicOn);
  const [videoOn, setVideoOn]             = useState(initialVideoOn);
  const [panelSizeMode, setPanelSizeMode] = useState('normal'); // 'normal' | 'maximized' | 'minimized'
  const [isLeaveModalOpen, setIsLeaveModalOpen] = useState(false);
  const [isConnected, setIsConnected]     = useState(socket.connected);
  const [peers, setPeers]                 = useState([]);
  const [userStream, setUserStream]       = useState(null);
  const [workspaceView, setWorkspaceView] = useState('all');
  const [isRoomActionsOpen, setIsRoomActionsOpen] = useState(false);
  const [isStudioDockOpen, setIsStudioDockOpen] = useState(true);
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(true);
  const [activeCategory, setActiveCategory] = useState(null); // By default closed (bnd), opens whichever category user clicks
  const [isHeaderMenuOpen, setIsHeaderMenuOpen] = useState(false);

  // Close header 3-dots menu on click outside
  useEffect(() => {
    if (!isHeaderMenuOpen) return;
    const handleCloseHeaderMenu = () => setIsHeaderMenuOpen(false);
    window.addEventListener('click', handleCloseHeaderMenu);
    return () => window.removeEventListener('click', handleCloseHeaderMenu);
  }, [isHeaderMenuOpen]);

  // Host & Room state
  const [participants, setParticipants] = useState([]);
  const [isRoomLocked, setIsRoomLocked] = useState(false);
  const [isMuteAllActive, setIsMuteAllActive] = useState(false);
  const [isMutedByHost, setIsMutedByHost] = useState(false);

  // Floating Toast Notification
  const [toast, setToast] = useState({ show: false, message: '', type: 'success' });
  const toastTimeoutRef = useRef(null);

  const showToast = (message, type = 'success') => {
    if (toastTimeoutRef.current) clearTimeout(toastTimeoutRef.current);
    setToast({ show: true, message, type });
    toastTimeoutRef.current = setTimeout(() => {
      setToast(prev => ({ ...prev, show: false }));
    }, 3200);
  };

  const handleRecordSessionHistoryAndLeave = () => {
    try {
      const userKey = user?.email
        ? `synclearn_completed_sessions_${user.email.toLowerCase().trim()}`
        : (user?._id ? `synclearn_completed_sessions_${user._id}` : null);
      if (userKey) {
        const existing = JSON.parse(localStorage.getItem(userKey) || '[]');
        const cleanR = cleanRoomId(roomId);
        const rosterCount = (() => {
          try {
            const r = JSON.parse(localStorage.getItem('synclearn_attendance_' + cleanR) || '[]');
            return Array.isArray(r) ? r.length : 0;
          } catch(e) { return 0; }
        })();
        const totalAttendees = Math.max(participants.length, rosterCount, 1);

        const savedTopic = localStorage.getItem('synclearn_topic_' + cleanR) || localStorage.getItem('synclearn_topic_' + cleanR.replace(/-/g, '')) || '';
        const savedHost = localStorage.getItem('synclearn_host_' + cleanR) || localStorage.getItem('synclearn_host_' + cleanR.replace(/-/g, '')) || '';

        const validTopic = (currentLectureTopic && currentLectureTopic !== 'Live Classroom' && !currentLectureTopic.startsWith('Live Session') && currentLectureTopic !== 'Untitled Class')
          ? currentLectureTopic
          : (savedTopic || 'SyncLearn Interactive Session');

        const validHost = isInstructor ? (user?.name || 'Instructor') : (savedHost || roomHostName || 'Instructor');

        const newRecord = {
          code: roomId,
          title: validTopic,
          topic: validTopic,
          date: 'Just now',
          time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
          students: totalAttendees,
          instructor: validHost
        };
        const updated = [newRecord, ...existing.filter(s => s.code !== roomId)].slice(0, 10);
        localStorage.setItem(userKey, JSON.stringify(updated));
      }
    } catch (e) {
      console.warn('Failed to save session history:', e);
    }
    if (onLeaveRoom) onLeaveRoom();
  };

  // Network LAN IP & Public Tunnel URL for sharing to mobile / WhatsApp / other devices
  const [networkLanIp, setNetworkLanIp] = useState('192.168.100.135');
  const [tunnelUrl, setTunnelUrl] = useState('https://terrorism-numbers-yarn-planes.trycloudflare.com');

  useEffect(() => {
    fetch('/api/v1/network-info')
      .then(r => r.json())
      .then(d => {
        if (d?.lanIp && d.lanIp !== 'localhost') {
          setNetworkLanIp(d.lanIp);
        }
        if (d?.tunnelUrl && d.tunnelUrl.startsWith('http')) {
          setTunnelUrl(d.tunnelUrl);
        }
      })
      .catch(() => {});
  }, []);

  const getShareableLink = (preferLocal = false) => {
    if (!roomId) return '';
    const currentHost = isInstructor ? (user?.name || '') : (roomHostName || '');
    const hostParam = currentHost ? `&host=${encodeURIComponent(currentHost)}` : '';
    const cleanTopic = (currentLectureTopic && currentLectureTopic !== 'Live Classroom' && !currentLectureTopic.startsWith('Live Session'))
      ? currentLectureTopic
      : '';
    const topicParam = cleanTopic ? `&topic=${encodeURIComponent(cleanTopic)}` : '';

    if (preferLocal === true || preferLocal === 'local') {
      return `${window.location.protocol}//localhost:${window.location.port || '5173'}/?room=${encodeURIComponent(roomId)}${hostParam}${topicParam}`;
    }

    if (preferLocal === 'wifi') {
      const host = (networkLanIp && networkLanIp !== 'localhost') ? networkLanIp : '192.168.100.135';
      return `${window.location.protocol}//${host}:${window.location.port || '5173'}/?room=${encodeURIComponent(roomId)}${hostParam}${topicParam}`;
    }

    // Default: 'mobile' / false -> Prioritize active HTTPS public tunnel for WhatsApp
    // When sent in WhatsApp, an HTTPS URL on a public domain becomes a 100% clickable green hyperlink!
    if (window.location.hostname !== 'localhost' && window.location.hostname !== '127.0.0.1') {
      return `${window.location.origin}/?room=${encodeURIComponent(roomId)}${hostParam}${topicParam}`;
    }
    if (tunnelUrl && tunnelUrl.startsWith('http')) {
      const cleanTunnel = tunnelUrl.replace(/\/+$/, '');
      return `${cleanTunnel}/?room=${encodeURIComponent(roomId)}${hostParam}${topicParam}`;
    }
    const host = (networkLanIp && networkLanIp !== 'localhost')
      ? networkLanIp
      : '192.168.100.135';
    return `${window.location.protocol}//${host}:${window.location.port || '5173'}/?room=${encodeURIComponent(roomId)}${hostParam}${topicParam}`;
  };

  const copyRoomCode = () => {
    if (!roomId) return;
    navigator.clipboard.writeText(roomId)
      .then(() => showToast(`📋 Room Code "${roomId}" copied to clipboard!`))
      .catch(() => showToast('Failed to copy room code', 'error'));
  };

  const copyInviteLink = (preferLocal = false) => {
    if (!roomId) return;
    const inviteUrl = getShareableLink(preferLocal);
    navigator.clipboard.writeText(inviteUrl)
      .then(() => {
        if (preferLocal === true || preferLocal === 'local') {
          showToast(`💻 Localhost PC Link copied: ${inviteUrl}`);
        } else {
          showToast(`📱 WhatsApp & Mobile Link copied! Ready to paste in WhatsApp: ${inviteUrl}`, 'success');
        }
      })
      .catch(() => showToast('Failed to copy invite link', 'error'));
  };

  const formatMeetingIdWithDashes = (id) => {
    if (!id) return '';
    const str = String(id).trim();
    if (str.includes('-')) return str;
    const digitsOnly = str.replace(/\s+/g, '');
    if (/^\d{9}$/.test(digitsOnly)) {
      return `${digitsOnly.slice(0, 3)}-${digitsOnly.slice(3, 6)}-${digitsOnly.slice(6, 9)}`;
    }
    if (/^\d{10}$/.test(digitsOnly)) {
      return `${digitsOnly.slice(0, 3)}-${digitsOnly.slice(3, 6)}-${digitsOnly.slice(6, 10)}`;
    }
    if (/^\d{6}$/.test(digitsOnly)) {
      return `${digitsOnly.slice(0, 3)}-${digitsOnly.slice(3, 6)}`;
    }
    return str;
  };

  const generateMeetingPasscode = () => {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
    let code = '';
    for (let i = 0; i < 6; i++) {
      code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return code;
  };

  const copyClassInvitation = () => {
    if (!roomId) return;
    const inviteUrl = getShareableLink(false);
    const wifiUrl = getShareableLink('wifi');
    const formattedId = formatMeetingIdWithDashes(roomId);
    const instructorName = isInstructor ? (user?.name || 'Instructor') : (roomHostName || 'Instructor');
    const topicTitle = (currentLectureTopic && currentLectureTopic !== 'Live Classroom' && !currentLectureTopic.startsWith('Live Session'))
      ? currentLectureTopic
      : 'Live Classroom Interactive Session';
    const nowStr = new Date().toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
    const text = `🎓 SyncLearn Live Classroom Invitation\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n👨‍🏫 Instructor: ${instructorName}\n📚 Topic: ${topicTitle}\n📅 Date: ${nowStr} (Live In Session)\n\n🔗 Join Live Class (Mobile & PC):\n${inviteUrl}\n\n🆔 Meeting ID: ${formattedId}\n🔐 Passcode: ${roomPasscode}\n\n💡 Student Guidelines:\n1. Click the link above or open SyncLearn and enter Meeting ID: ${formattedId}\n2. Please join 5 minutes early with your camera and microphone enabled.\n3. Access real-time dual whiteboard, lecture typing pad, and AI quizzes.\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`;
    navigator.clipboard.writeText(text)
      .then(() => showToast('📋 WhatsApp class invitation copied! Ready to paste in WhatsApp.', 'success'))
      .catch(() => showToast('Failed to copy invitation', 'error'));
  };
  const copyZoomInvitation = copyClassInvitation;

  // ── Audio, Video & Participants Zoom-Style Menu States ──
  const [isAudioMenuOpen, setIsAudioMenuOpen] = useState(false);
  const [isVideoMenuOpen, setIsVideoMenuOpen] = useState(false);
  const [isParticipantsMenuOpen, setIsParticipantsMenuOpen] = useState(false);

  const [availableMics, setAvailableMics] = useState([
    { deviceId: 'default', label: 'Microphone Array (Default)' }
  ]);
  const [selectedMicId, setSelectedMicId] = useState(() => {
    return localStorage.getItem('synclearn_preferred_mic') || 'default';
  });

  const [availableSpeakers, setAvailableSpeakers] = useState([
    { deviceId: 'default', label: 'Speakers (Default)' }
  ]);
  const [selectedSpeakerId, setSelectedSpeakerId] = useState(() => {
    return localStorage.getItem('synclearn_preferred_speaker') || 'default';
  });
  const [micPermissionBlocked, setMicPermissionBlocked] = useState(false);

  const [micMode, setMicMode] = useState('noise-removal');

  const [availableCameras, setAvailableCameras] = useState([
    { deviceId: 'default', label: 'Integrated Camera' },
    { deviceId: 'system-cam', label: 'Same as system (Integrated Camera)' }
  ]);
  const [selectedCameraId, setSelectedCameraId] = useState('default');

  const [isBackgroundBlurred, setIsBackgroundBlurred] = useState(initialBlurBackground);
  const [isAutoFramed, setIsAutoFramed] = useState(false);

  // ── Image 2, 3, 4: Host Tools & Meeting Info States ──
  const [isHostToolsOpen, setIsHostToolsOpen] = useState(false);
  const [isMeetingInfoOpen, setIsMeetingInfoOpen] = useState(false);
  const [isWaitingRoomEnabled, setIsWaitingRoomEnabled] = useState(false);
  const [hideProfilePictures, setHideProfilePictures] = useState(false);
  const [isDescriptionExpanded, setIsDescriptionExpanded] = useState(true);
  const [roomPasscode, setRoomPasscode] = useState(() => {
    try {
      const cleanR = cleanRoomId(roomId);
      const saved = localStorage.getItem('synclearn_passcode_' + cleanR) || localStorage.getItem('synclearn_passcode_' + roomId);
      if (saved) return saved;
    } catch(e) {}
    const newPass = generateMeetingPasscode();
    try {
      const cleanR = cleanRoomId(roomId);
      localStorage.setItem('synclearn_passcode_' + cleanR, newPass);
      localStorage.setItem('synclearn_passcode_' + roomId, newPass);
    } catch(e) {}
    return newPass;
  });
  const roomPasscodeRef = useRef(roomPasscode);
  useEffect(() => {
    roomPasscodeRef.current = roomPasscode;
  }, [roomPasscode]);
  const [activeSecurityAlert, setActiveSecurityAlert] = useState(null);

  // Auto-dismiss security alert after 8 seconds
  useEffect(() => {
    if (activeSecurityAlert) {
      const timer = setTimeout(() => {
        setActiveSecurityAlert(null);
      }, 8500);
      return () => clearTimeout(timer);
    }
  }, [activeSecurityAlert]);

  const footerRef = useRef(null);
  const headerActionsRef = useRef(null);
  const meetingInfoRef = useRef(null);

  // Enumerate actual media devices if available in browser
  useEffect(() => {
    if (navigator.mediaDevices && navigator.mediaDevices.enumerateDevices) {
      navigator.mediaDevices.enumerateDevices()
        .then(devices => {
          const mics = devices.filter(d => d.kind === 'audioinput' && d.label).map((d, i) => ({
            deviceId: d.deviceId || `mic-${i}`,
            label: d.label
          }));
          if (mics.length > 0) {
            setAvailableMics([
              mics[0],
              { deviceId: 'system', label: `Same as system (${mics[0].label})` },
              ...mics.slice(1)
            ]);
          }

          const cams = devices.filter(d => d.kind === 'videoinput' && d.label).map((d, i) => ({
            deviceId: d.deviceId || `cam-${i}`,
            label: d.label
          }));
          if (cams.length > 0) {
            setAvailableCameras([
              cams[0],
              { deviceId: 'system-cam', label: `Same as system (${cams[0].label})` },
              ...cams.slice(1)
            ]);
          }

          const spks = devices.filter(d => d.kind === 'audiooutput' && d.label).map((d, i) => ({
            deviceId: d.deviceId || `spk-${i}`,
            label: d.label
          }));
          if (spks.length > 0) {
            setAvailableSpeakers([
              { deviceId: 'system', label: `Same as system (${spks[0].label})` },
              ...spks
            ]);
          }
        })
        .catch(err => console.log('Device query notice:', err));
    }
  }, []);

  // Close popup menus on outside click
  useEffect(() => {
    const handleOutsideClick = (e) => {
      const isInsideFooter = footerRef.current && footerRef.current.contains(e.target);
      const isInsideMeetingInfo = meetingInfoRef.current && meetingInfoRef.current.contains(e.target);
      if (!isInsideFooter && !isInsideMeetingInfo) {
        setIsAudioMenuOpen(false);
        setIsVideoMenuOpen(false);
        setIsParticipantsMenuOpen(false);
        setIsHostToolsOpen(false);
        setIsMeetingInfoOpen(false);
      }
    };
    document.addEventListener('mousedown', handleOutsideClick);
    document.addEventListener('touchstart', handleOutsideClick, { passive: true });
    return () => {
      document.removeEventListener('mousedown', handleOutsideClick);
      document.removeEventListener('touchstart', handleOutsideClick);
    };
  }, []);

  const handleSwitchMicrophone = async (newMicId) => {
    setSelectedMicId(newMicId);
    try {
      localStorage.setItem('synclearn_preferred_mic', newMicId);
      const audioStream = await navigator.mediaDevices.getUserMedia({
        audio: newMicId && newMicId !== 'default' && newMicId !== 'system'
          ? { deviceId: { exact: newMicId }, echoCancellation: true, noiseSuppression: true, autoGainControl: true }
          : { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
      });
      const newAudioTrack = audioStream.getAudioTracks()[0];
      if (newAudioTrack) {
        newAudioTrack.enabled = micOn;
        if (userStreamRef.current) {
          userStreamRef.current.getAudioTracks().forEach(t => {
            try { t.stop(); } catch (e) {}
            userStreamRef.current.removeTrack(t);
          });
          userStreamRef.current.addTrack(newAudioTrack);
        }
        peersRef.current.forEach(p => {
          try {
            const sender = p.peer?._pc?.getSenders()?.find(s => (s.track && s.track.kind === 'audio') || s.kind === 'audio');
            if (sender) sender.replaceTrack(newAudioTrack);
          } catch (e) {}
        });
        setUserStream(new MediaStream(userStreamRef.current.getTracks()));
        const label = availableMics.find(m => m.deviceId === newMicId)?.label || 'Microphone';
        showToast(`🎙️ Switched to ${label}`);
      }
    } catch (err) {
      console.warn('Switch mic error:', err);
      showToast('⚠️ Could not switch microphone.');
    }
  };

  const handleSwitchSpeaker = async (newSpeakerId) => {
    setSelectedSpeakerId(newSpeakerId);
    try {
      localStorage.setItem('synclearn_preferred_speaker', newSpeakerId);
      const allAudioEls = document.querySelectorAll('audio, video');
      allAudioEls.forEach(el => {
        if (typeof el.setSinkId === 'function') {
          el.setSinkId(newSpeakerId === 'default' || newSpeakerId === 'system' ? '' : newSpeakerId).catch(() => {});
        }
      });
      const label = availableSpeakers.find(s => s.deviceId === newSpeakerId)?.label || 'Speaker';
      showToast(`🔊 Output set to ${label}`);
    } catch (err) {
      console.warn('Switch speaker error:', err);
    }
  };

  const handleTestAudioAndMic = () => {
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (AudioCtx) {
        const ctx = new AudioCtx();
        const notes = [523.25, 659.25, 783.99, 1046.50]; // C5, E5, G5, C6
        const step = 0.16;
        const now = ctx.currentTime;
        notes.forEach((freq, idx) => {
          const osc = ctx.createOscillator();
          const gain = ctx.createGain();
          osc.type = 'triangle';
          osc.frequency.setValueAtTime(freq, now + idx * step);
          gain.gain.setValueAtTime(0.3, now + idx * step);
          gain.gain.exponentialRampToValueAtTime(0.001, now + idx * step + step + 0.2);
          osc.connect(gain);
          gain.connect(ctx.destination);
          osc.start(now + idx * step);
          osc.stop(now + idx * step + step + 0.2);
        });
        setTimeout(() => {
          try { ctx.close(); } catch(e) {}
        }, 1200);
      }
    } catch (e) {
      console.warn('Audio test error:', e);
    }
    showToast('🔊 Audio chime played! Speaker and microphone working.');
    setIsAudioMenuOpen(false);
  };

  // Speech transcription & Notes state
  const [transcription, setTranscription] = useState([]);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [manualNoteInput, setManualNoteInput] = useState('');
  const speechRecognitionRef = useRef(null);
  const isTranscribingRef = useRef(false);

  // Live captions (separate from the lecture-notes transcription control).
  const [isLiveCaptionsOn, setIsLiveCaptionsOn] = useState(false);
  const [liveCaptionText, setLiveCaptionText] = useState('');
  const liveCaptionRecognitionRef = useRef(null);
  const liveCaptionOnRef = useRef(false);
  const liveCaptionClearTimerRef = useRef(null);
  const liveCaptionRestartTimerRef = useRef(null);

  // Chat, Doubts & File Sharing
  const [messages, setMessages]           = useState([]);
  const [newMessage, setNewMessage]       = useState('');
  const [isDoubtMode, setIsDoubtMode]     = useState(false);
  const [selectedFile, setSelectedFile]   = useState(null);
  const [pinnedDoubts, setPinnedDoubts]   = useState([]);
  const [showPinnedDoubts, setShowPinnedDoubts] = useState(true);
  const [isChatLocked, setIsChatLocked]   = useState(false);
  const [unreadChatCount, setUnreadChatCount] = useState(0);
  const [pendingAdmissionRequests, setPendingAdmissionRequests] = useState([]);
  const [currentAdmissionPrompt, setCurrentAdmissionPrompt] = useState(null);
  const fileInputRef = useRef(null);
  const chatEndRef   = useRef(null);
  const activeTabRef = useRef(activeTab);

  useEffect(() => {
    activeTabRef.current = activeTab;
    if (activeTab === 'chat') {
      setUnreadChatCount(0);
    }
  }, [activeTab]);

  const cameraTrackRef  = useRef(null);

  // ── Category 1: Coursera-style Gemini Class Coach & Engagement States ──
  const [currentLectureTopic, setCurrentLectureTopic] = useState(() => {
    try {
      const cleanR = cleanRoomId(roomId);
      const saved = localStorage.getItem('synclearn_topic_' + cleanR) || 
                    localStorage.getItem('synclearn_topic_' + cleanR.replace(/-/g, '')) ||
                    localStorage.getItem('synclearn_meeting_topic') || '';
      return saved.trim() || 'WebRTC & Real-Time Sync';
    } catch (e) {
      return 'WebRTC & Real-Time Sync';
    }
  });
  const [showPromptSuggestions, setShowPromptSuggestions] = useState(false);
  const [hasHandRaised, setHasHandRaised]     = useState(false);
  const [handRaisedUsers, setHandRaisedUsers] = useState({}); // { socketId: { studentName, time } }
  const [engagementStats, setEngagementStats] = useState({}); // { socketId: { isFocused, score } }
  const [peerMediaStates, setPeerMediaStates] = useState({}); // { socketId: { videoOn, micOn } }
  const [localMicVolume, setLocalMicVolume]   = useState(0); // 0 to 100
  const [isMicTesting, setIsMicTesting]       = useState(false);
  const micTestAudioRef                       = useRef(null);

  // Gemini Class Coach Chat State (Coursera-style topic-aware assistant)
  const [aiChatMessages, setAiChatMessages]   = useState([
    {
      id: 'ai-intro',
      sender: 'assistant',
      text: "👋 **Welcome to Gemini Class Coach!**\n\nI am your live AI academic assistant, synchronized with this lecture's topic. Ask questions, explore code examples, get real-world analogies, or click any topic chip below!",
      time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    }
  ]);
  const [aiPromptInput, setAiPromptInput]     = useState('');
  const [isAiThinking, setIsAiThinking]       = useState(false);
  const aiChatEndRef                          = useRef(null);

  // ── Category 3: Session Recording States ──
  const [isRecordingSession, setIsRecordingSession]   = useState(false);
  const [remoteRecordingNotice, setRemoteRecordingNotice] = useState(null); // { isRecording, recordedByName }
  const mediaRecorderRef                              = useRef(null);
  const recordedChunksRef                             = useRef([]);

  const userVideoRef  = useRef(null);
  const userStreamRef = useRef(null);
  const peersRef      = useRef([]);

  // Auto-scroll chat
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // Fetch official room topic & instructor from backend to guarantee student has the exact classroom topic
  useEffect(() => {
    const cleanR = cleanRoomId(roomId);
    if (!cleanR) return;
    fetch(`/api/v1/rooms/${cleanR}/info`)
      .then(r => r.json())
      .then(d => {
        if (d?.success && d.title && d.title !== 'Live Classroom' && d.title.trim().length > 1) {
          const freshTopic = d.title.trim();
          setCurrentLectureTopic(freshTopic);
          try {
            localStorage.setItem('synclearn_topic_' + cleanR, freshTopic);
            localStorage.setItem('synclearn_topic_' + cleanR.replace(/-/g, ''), freshTopic);
          } catch(e) {}
        }
      })
      .catch(e => console.warn('Failed to fetch room topic info:', e));
  }, [roomId]);



  // Auto-record session attendance in real-time when room is entered or roster updates
  useEffect(() => {
    if (!roomId) return;
    try {
      const userKey = user?.email
        ? `synclearn_completed_sessions_${user.email.toLowerCase().trim()}`
        : (user?._id ? `synclearn_completed_sessions_${user._id}` : null);
      if (userKey) {
        const existing = JSON.parse(localStorage.getItem(userKey) || '[]');
        const cleanR = cleanRoomId(roomId);
        const rosterCount = (() => {
          try {
            const r = JSON.parse(localStorage.getItem('synclearn_attendance_' + cleanR) || '[]');
            return Array.isArray(r) ? r.length : 0;
          } catch(e) { return 0; }
        })();
        const totalAttendees = Math.max(participants.length, rosterCount, 1);

        const validTopic = (currentLectureTopic && currentLectureTopic !== 'Live Classroom' && !currentLectureTopic.startsWith('Live Session') && currentLectureTopic !== 'Untitled Class')
          ? currentLectureTopic
          : (localStorage.getItem('synclearn_topic_' + cleanR) || localStorage.getItem('synclearn_topic_' + cleanR.replace(/-/g, '')) || 'SyncLearn Interactive Session');

        const validHost = isInstructor ? (user?.name || 'Instructor') : (roomHostName || localStorage.getItem('synclearn_host_' + cleanR) || 'Instructor');

        const newRecord = {
          code: roomId,
          title: validTopic,
          topic: validTopic,
          date: 'Today',
          time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
          students: totalAttendees,
          instructor: validHost
        };
        const updated = [newRecord, ...existing.filter(s => s.code !== roomId)].slice(0, 10);
        localStorage.setItem(userKey, JSON.stringify(updated));
      }
    } catch (e) {
      console.warn('Session auto-record error:', e);
    }
  }, [roomId, isInstructor, user, participants.length, currentLectureTopic, roomHostName]);

  const userRef = useRef(user);
  userRef.current = user;
  const isInstructorRef = useRef(isInstructor);
  isInstructorRef.current = isInstructor;

  // WebRTC & Socket init
  useEffect(() => {
    socket.connect();
    const cleanRoom = cleanRoomId(roomId);
    let currentStream = null;

    const resolveStream = async () => {
      let stream = initialStream;
      let hasRealVideo = false;

      if (!stream || !stream.getTracks || !stream.getTracks().some(t => t.readyState === 'live')) {
        const acquired = await acquireMediaStream(userRef.current?.name, isInstructorRef.current);
        stream = acquired.stream;
        hasRealVideo = acquired.hasRealVideo;
      } else {
        hasRealVideo = stream.getVideoTracks().some(t => t.readyState === 'live' && !t._isSynthetic);
      }

      // If no audio track present, attempt to acquire a real hardware microphone track
      if (stream.getAudioTracks().length === 0) {
        try {
          const micOnlyStream = await navigator.mediaDevices.getUserMedia({ audio: true });
          const aTrack = micOnlyStream?.getAudioTracks()[0];
          if (aTrack) {
            aTrack.enabled = Boolean(initialMicOn);
            stream.addTrack(aTrack);
          }
        } catch (e) {
          console.warn('Initial microphone acquisition skipped or denied:', e);
        }
      }

      // Guarantee at least 1 audio track so audio transceiver always negotiates
      if (stream.getAudioTracks().length === 0) {
        try {
          const silentTrack = createSilentAudioTrack();
          if (silentTrack) {
            stream.addTrack(silentTrack);
          }
        } catch (e) {}
      }

      // Guarantee at least 1 video track so video transceiver always negotiates
      if (stream.getVideoTracks().length === 0) {
        try {
          const canvasStream = createFallbackStream(user?.name, isInstructor);
          if (canvasStream) {
            const vTrack = canvasStream.getVideoTracks()[0];
            if (vTrack) {
              vTrack._isSynthetic = true;
              vTrack.enabled = Boolean(initialVideoOn);
              stream.addTrack(vTrack);
            }
          }
        } catch(e) {}
      }

      return { stream, hasRealVideo };
    };

    resolveStream().then(({ stream, hasRealVideo }) => {
      currentStream = stream;
      userStreamRef.current = stream;
      setUserStream(stream);

      const shouldEnableVideo = Boolean(initialVideoOn && hasRealVideo);
      setVideoOn(shouldEnableVideo);

      const videoTrack = stream.getVideoTracks()[0];
      if (videoTrack) {
        cameraTrackRef.current = videoTrack;
        videoTrack.enabled = shouldEnableVideo;
      }

      const audioTrack = stream.getAudioTracks()[0];
      if (audioTrack) {
        audioTrack.enabled = Boolean(initialMicOn);
      }
      setMicOn(Boolean(initialMicOn));

      // Always join the socket room unconditionally
      socket.emit('join-room', {
        roomId: cleanRoom,
        userId: socket.id,
        userName: userRef.current?.name || (isInstructorRef.current ? 'Instructor' : 'Student'),
        userRole: isInstructorRef.current ? 'instructor' : (userRef.current?.role || 'student'),
        roomTopic: currentLectureTopic
      });
      socket.emit('media-state-change', { roomId: cleanRoom, videoOn: shouldEnableVideo, micOn: Boolean(initialMicOn) });
      if (isInstructorRef.current && (roomPasscodeRef.current || roomPasscode)) {
        socket.emit('set-room-passcode', { roomId: cleanRoom, passcode: roomPasscodeRef.current || roomPasscode });
      }

      // WebRTC Peer signaling listeners
      socket.on('user-connected', userId => {
        const existing = peersRef.current.find(p => p.peerID === userId);
        if (existing && existing.peer && !existing.peer.destroyed) {
          const pc = existing.peer._pc;
          if (pc && (pc.connectionState === 'connected' || pc.iceConnectionState === 'connected')) {
            console.log(`ℹ️ Peer ${userId} already connected, skipping duplicate negotiation`);
            return;
          }
          try { existing.peer.destroy(); } catch (e) {}
          peersRef.current = peersRef.current.filter(p => p.peerID !== userId);
        }
        const activeMedia = userStreamRef.current || currentStream;
        const peer = createPeer(userId, socket.id, activeMedia);
        peersRef.current.push({ peerID: userId, peer });
        setPeers(prev => [...prev.filter(p => p.peerID !== userId), { peerID: userId, peer }]);
        // Immediately sync our current media state with the newly connected peer
        socket.emit('media-state-change', {
          roomId: cleanRoom,
          videoOn: Boolean(userStreamRef.current?.getVideoTracks()[0]?.enabled),
          micOn: Boolean(userStreamRef.current?.getAudioTracks()[0]?.enabled)
        });
      });

      socket.on('user-joined', payload => {
        const existing = peersRef.current.find(p => p.peerID === payload.callerID);
        if (existing && existing.peer && !existing.peer.destroyed) {
          const pc = existing.peer._pc;
          if (pc && (pc.connectionState === 'connected' || pc.iceConnectionState === 'connected')) {
            console.log(`ℹ️ Peer ${payload.callerID} already connected, skipping duplicate offer`);
            return;
          }
          try { existing.peer.destroy(); } catch (e) {}
          peersRef.current = peersRef.current.filter(p => p.peerID !== payload.callerID);
        }
        const activeMedia = userStreamRef.current || currentStream;
        const peer = addPeer(payload.signal, payload.callerID, activeMedia);
        peersRef.current.push({ peerID: payload.callerID, peer });
        setPeers(prev => [...prev.filter(p => p.peerID !== payload.callerID), { peerID: payload.callerID, peer }]);
        // Immediately sync our current media state with the newly joined peer
        socket.emit('media-state-change', {
          roomId: cleanRoom,
          videoOn: Boolean(userStreamRef.current?.getVideoTracks()[0]?.enabled),
          micOn: Boolean(userStreamRef.current?.getAudioTracks()[0]?.enabled)
        });
      });

      socket.on('receiving-returned-signal', payload => {
        const item = peersRef.current.find(p => p.peerID === payload.id);
        if (item && item.peer && !item.peer.destroyed) {
          try {
            const pc = item.peer._pc;
            if (pc && pc.signalingState === 'stable') {
              console.log(`ℹ️ Peer ${payload.id} connection is already stable, skipping duplicate answer`);
              return;
            }
            item.peer.signal(payload.signal);
          } catch (e) {
            console.warn('Error passing returned signal to peer:', e);
          }
        }
      });

      socket.on('user-disconnected', userId => {
        const peerObj = peersRef.current.find(p => p.peerID === userId);
        if (peerObj) peerObj.peer.destroy();
        const remaining = peersRef.current.filter(p => p.peerID !== userId);
        peersRef.current = remaining;
        setPeers(remaining);
      });
    }).catch(err => {
      console.warn('acquireMediaStream error fallback:', err);
      // Even on complete error, join the room!
      socket.emit('join-room', {
        roomId: cleanRoom,
        userId: socket.id,
        userName: user?.name || (isInstructor ? 'Instructor' : 'Student'),
        userRole: user?.role || 'student',
      });
    });

    // Receive live chat messages (with strict deduplication & unread counter)
    socket.on('receive-message', data => {
      if (!data) return;
      setMessages(prev => {
        if (data.id && prev.some(m => m.id === data.id)) return prev;
        if (prev.some(m => m.message === data.message && m.senderId === data.senderId && m.time === data.time)) return prev;
        return [...prev, data];
      });

      // Track unread messages when chat tab is closed
      if (activeTabRef.current !== 'chat' && data.senderId !== socket.id) {
        setUnreadChatCount(prev => prev + 1);
      }
    });

    // Student Admission Waiting Room (Instructor Listeners)
    socket.on('admission-request', ({ student, pendingList }) => {
      if (isInstructor) {
        if (Array.isArray(pendingList)) {
          setPendingAdmissionRequests(pendingList);
        } else if (student) {
          setPendingAdmissionRequests(prev => {
            if (prev.some(s => s.socketId === student.socketId)) return prev;
            return [...prev, student];
          });
        }
        if (student) {
          setCurrentAdmissionPrompt(student);
          // Play notification chime
          try {
            const AudioCtx = window.AudioContext || window.webkitAudioContext;
            if (AudioCtx) {
              const ctx = window.__synclearnGlobalAudioCtx || new AudioCtx();
              if (ctx && ctx.state !== 'closed') {
                if (ctx.state === 'suspended') ctx.resume().catch(() => {});
                const osc = ctx.createOscillator();
                const gain = ctx.createGain();
                osc.type = 'sine';
                osc.frequency.setValueAtTime(587.33, ctx.currentTime);
                osc.frequency.setValueAtTime(880, ctx.currentTime + 0.12);
                gain.gain.setValueAtTime(0.2, ctx.currentTime);
                gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.35);
                osc.connect(gain);
                gain.connect(ctx.destination);
                osc.start();
                osc.stop(ctx.currentTime + 0.35);
              }
            }
          } catch(e) {}
        }
      }
    });

    socket.on('pending-admissions-list', (list) => {
      if (isInstructor && Array.isArray(list)) {
        setPendingAdmissionRequests(list);
        if (list.length === 0) {
          setCurrentAdmissionPrompt(null);
        }
      }
    });

    // Secure Access Control: Passcode Sync & Real-time Security Alerts
    socket.on('room-passcode', ({ passcode }) => {
      if (passcode) {
        setRoomPasscode(passcode);
        window.__synclearnRoomPasscode = passcode;
        try { localStorage.setItem('synclearn_passcode_' + cleanRoom, passcode); } catch(e) {}
      }
    });

    socket.on('security-alert', (alert) => {
      if (isInstructor && alert) {
        setActiveSecurityAlert(alert);
        try {
          const AudioCtx = window.AudioContext || window.webkitAudioContext;
          if (AudioCtx) {
            const ctx = window.__synclearnGlobalAudioCtx || new AudioCtx();
            if (ctx && ctx.state !== 'closed') {
              if (ctx.state === 'suspended') ctx.resume().catch(() => {});
              const osc = ctx.createOscillator();
              const gain = ctx.createGain();
              osc.type = 'sawtooth';
              osc.frequency.setValueAtTime(440, ctx.currentTime);
              osc.frequency.setValueAtTime(330, ctx.currentTime + 0.15);
              gain.gain.setValueAtTime(0.18, ctx.currentTime);
              gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.4);
              osc.connect(gain);
              gain.connect(ctx.destination);
              osc.start();
              osc.stop(ctx.currentTime + 0.4);
            }
          }
        } catch (e) {}
      }
    });

    // Realtime chat lock status (teacher controls student chat capability)
    socket.on('chat-lock-status', ({ isLocked }) => {
      setIsChatLocked(Boolean(isLocked));
    });
    socket.on('chat-lock-error', (data) => {
      showToast(data?.message || '🔒 Chat has been locked by the instructor', 'error');
    });

    // Receive live lecture notes
socket.on('receive-transcription', (data) => {
  if (!data?.entry?.text) return;

  // Automatically show captions when a student receives them
  setIsLiveCaptionsOn(true);
  setLiveCaptionText(data.entry.text);

  setTranscription(prev => [...prev, data.entry]);

  if (liveCaptionClearTimerRef.current) {
    clearTimeout(liveCaptionClearTimerRef.current);
  }

  liveCaptionClearTimerRef.current = setTimeout(() => {
    setLiveCaptionText('');
  }, 6500);
});



    // Host Controls: Mute (all or individual)
    socket.on('force-mute', () => {
      if (!isInstructor) {
        setIsMutedByHost(true);
        setMicOn(false);
        if (userStreamRef.current) {
          userStreamRef.current.getAudioTracks().forEach(t => { t.enabled = false; });
        }
        peersRef.current.forEach(p => {
          try {
            const pc = p.peer?._pc;
            if (pc) {
              const sender = findAudioSender(pc);
              if (sender && sender.track) sender.track.enabled = false;
            }
          } catch(e) {}
        });
        socket.emit('media-state-change', { roomId: cleanRoom, videoOn, micOn: false });
        showToast('🔇 You have been muted by the instructor (Microphone locked)', 'error');
      }
    });

    socket.on('host-unmute-all', () => {
      if (!isInstructor) {
        setIsMutedByHost(false);
        showToast('🎙️ Instructor has unlocked participant microphones.', 'info');
      }
    });

    socket.on('host-unmute-student', () => {
      if (!isInstructor) {
        setIsMutedByHost(false);
        showToast('🎙️ Instructor has unlocked your microphone. You can now speak.', 'success');
      }
    });

    // Host Controls: Camera Toggle Override
    socket.on('force-toggle-camera', (data) => {
      if (!isInstructor) {
        setVideoOn(prev => {
          const nextVal = data?.action === 'on' ? true : (data?.action === 'off' ? false : !prev);
          const videoTrack = userStreamRef.current?.getVideoTracks()[0];
          if (videoTrack) videoTrack.enabled = nextVal;
          socket.emit('media-state-change', { roomId: cleanRoom, videoOn: nextVal, micOn });
          showToast(nextVal ? '📹 Instructor enabled your camera' : '📹 Instructor turned your camera OFF', 'info');
          return nextVal;
        });
      }
    });

    // Peer Media State Sync (Mic & Camera realtime indicator)
    socket.on('peer-media-state-change', ({ socketId, videoOn: peerVid, micOn: peerMic }) => {
      setPeerMediaStates(prev => ({
        ...prev,
        [socketId]: { videoOn: peerVid, micOn: peerMic }
      }));
    });

    socket.on('room-media-states-sync', (initialStates) => {
      if (initialStates && typeof initialStates === 'object') {
        setPeerMediaStates(prev => ({
          ...prev,
          ...initialStates
        }));
      }
    });

    // Host Controls: Remove Participant
    socket.on('force-removed', (data) => {
      alert(data?.reason || 'You have been removed from the session by the host.');
      if (onLeaveRoom) onLeaveRoom();
    });

    // Room Roster & Lock updates
    socket.on('room-participants-update', list => {
      if (Array.isArray(list)) {
        setParticipants(list);
        const activeSocketIds = new Set(list.map(p => p.socketId));

        // Immediately filter out and destroy any peers who have left the room
        setPeers(prev => {
          const toKeep = [];
          prev.forEach(p => {
            if (activeSocketIds.has(p.peerID)) {
              toKeep.push(p);
            } else {
              try { p.peer?.destroy(); } catch (e) {}
            }
          });
          peersRef.current = toKeep;
          return toKeep;
        });

        // ── Real-time Session Attendance Tracking ──
        try {
          const storageKey = 'synclearn_attendance_' + cleanRoom;
          let currentRoster = [];
          try {
            const raw = localStorage.getItem(storageKey);
            if (raw) currentRoster = JSON.parse(raw);
          } catch(e) {}
          if (!Array.isArray(currentRoster)) currentRoster = [];

          // Helper to normalize names for strict deduplication
          const normalizePerson = (str) => String(str || '').replace(/\(Instructor\)/gi, '').trim().toLowerCase();

          // Map existing entries by normalized name
          const rosterMap = new Map();
          currentRoster.forEach(item => {
            const key = normalizePerson(item.name || item.rawName || item.displayName);
            if (key) rosterMap.set(key, item);
          });

          const nowTime = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

          list.forEach(p => {
            const rawName = (p.userName || (p.userRole === 'instructor' ? 'Instructor' : 'Student')).trim();
            const normKey = normalizePerson(rawName);
            const isHost = p.userRole === 'instructor';
            const formattedName = isHost ? `${rawName} (Instructor)` : rawName;

            if (normKey && !rosterMap.has(normKey)) {
              rosterMap.set(normKey, {
                rawName,
                name: formattedName,
                role: isHost ? 'Instructor' : 'Student',
                joinTime: nowTime,
                leaveTime: '-',
                status: isHost ? 'Host / Present' : 'Present',
                verification: 'Verified'
              });
            } else if (normKey && rosterMap.has(normKey)) {
              const existing = rosterMap.get(normKey);
              if (isHost && !existing.name.includes('(Instructor)')) {
                existing.name = formattedName;
                existing.role = 'Instructor';
                existing.status = 'Host / Present';
              }
            }
          });

          // Check if any previously active participants left
          const activeNormSet = new Set(list.map(p => normalizePerson(p.userName || '')));
          for (const [key, item] of rosterMap.entries()) {
            if (!activeNormSet.has(key) && item.leaveTime === '-') {
              item.leaveTime = nowTime;
            }
          }

          const updatedRoster = Array.from(rosterMap.values());
          localStorage.setItem(storageKey, JSON.stringify(updatedRoster));
        } catch(e) {}
      }
    });

    socket.on('room-lock-status', ({ isLocked }) => {
      setIsRoomLocked(isLocked);
    });

    // Real-time peer join announcement toast
    socket.on('peer-joined-notification', (data) => {
      const roleBadge = data.userRole === 'instructor' ? '👨‍🏫 Instructor' : '🎓 Student';
      showToast(`🟢 ${data.userName} (${roleBadge}) just entered the room! (${data.totalCount} active)`, 'success');
    });

    socket.on('room-locked-error', data => {
      alert(data?.message || 'This room is currently locked by the instructor.');
      if (onLeaveRoom) onLeaveRoom();
    });

    // Host ends meeting for all participants
    socket.on('meeting-ended-by-host', (data) => {
      showToast('⚠️ The host has ended the classroom session for all participants.', 'info');
      setTimeout(() => {
        handleRecordSessionHistoryAndLeave();
      }, 1200);
    });

    // Pinned Doubts Sync
    socket.on('doubt-pinned', (doubt) => {
      setPinnedDoubts(prev => {
        if (prev.some(d => d.id === doubt.id)) return prev;
        return [...prev, doubt];
      });
    });

    socket.on('doubt-resolved', ({ doubtId }) => {
      setPinnedDoubts(prev => prev.filter(d => d.id !== doubtId));
    });

    // ── Workspace View Synchronization & Video Auto-Open ──
    socket.on('workspace-view-sync', (data) => {
      if (data?.view) {
        setWorkspaceView(data.view);
        const viewLabel = data.view === 'video' ? '🎬 Lecture Video & YouTube' : data.view === 'whiteboard' ? '🎨 Dual Whiteboard' : data.view === 'cameras' ? '👥 Camera Grid' : 'Unified All View';
        showToast(`📺 Teacher switched workspace view to: ${viewLabel}`, 'info');
      }
    });

    socket.on('video-source-change', (data) => {
      setWorkspaceView('video');
      if (data?.videoTitle) {
        setCurrentLectureTopic(data.videoTitle);
      }
      showToast(`🎬 Teacher started video: ${data?.videoTitle || 'YouTube Stream'}`, 'info');
    });

    // ── Topic Sync from Instructor ──
    socket.on('room-topic-sync', ({ topic }) => {
      if (topic && typeof topic === 'string' && topic.trim()) {
        setCurrentLectureTopic(topic.trim());
      }
    });

    // ── Category 1: Hand Raise Events ──
    socket.on('student-hand-raised', (data) => {
      setHandRaisedUsers(prev => {
        const next = { ...prev };
        const entry = { studentName: data.studentName, time: data.time || new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) };
        if (data.socketId) next[data.socketId] = entry;
        if (data.userId) next[data.userId] = entry;
        if (data.studentName) next[data.studentName] = entry;
        return next;
      });
      showToast(`✋ ${data.studentName} raised their hand!`, 'info');
    });

    socket.on('student-hand-lowered', (data) => {
      setHandRaisedUsers(prev => {
        const next = { ...prev };
        if (data.socketId) delete next[data.socketId];
        if (data.userId) delete next[data.userId];
        if (data.studentName) delete next[data.studentName];
        return next;
      });
    });

    // ── Category 1: Peer Engagement Telemetry ──
    socket.on('peer-engagement-stat', (data) => {
      setEngagementStats(prev => ({
        ...prev,
        [data.socketId]: {
          studentName: data.studentName,
          isFocused: data.isFocused,
          score: data.score
        }
      }));
    });

    // ── Category 3: Remote Recording Status ──
    socket.on('recording-status-change', (data) => {
      setRemoteRecordingNotice(data);
      if (data.isRecording) {
        showToast(`⏺️ Session recording started by ${data.recordedByName || 'Host'}`, 'info');
      } else {
        showToast('⏹️ Session recording stopped', 'info');
      }
    });

    socket.on('connect',    () => setIsConnected(true));
    socket.on('disconnect', () => setIsConnected(false));

    return () => {
      peersRef.current.forEach(p => {
        try { p.peer?.destroy(); } catch (e) {}
      });
      peersRef.current = [];
      userStreamRef.current?.getTracks().forEach(t => t.stop());
      socket.off('connect'); socket.off('disconnect');
      socket.off('user-connected'); socket.off('user-joined');
      socket.off('receiving-returned-signal'); socket.off('user-disconnected');
      socket.off('receive-message'); socket.off('receive-transcription');
      socket.off('admission-request'); socket.off('pending-admissions-list');
      socket.off('chat-lock-status'); socket.off('chat-lock-error');
      socket.off('force-mute'); socket.off('force-removed');
      socket.off('host-unmute-all'); socket.off('host-unmute-student');
      socket.off('force-toggle-camera'); socket.off('peer-media-state-change');
      socket.off('room-media-states-sync');
      socket.off('room-participants-update'); socket.off('room-lock-status');
      socket.off('room-locked-error');
      socket.off('doubt-pinned'); socket.off('doubt-resolved');
      socket.off('workspace-view-sync'); socket.off('video-source-change');
      socket.off('room-topic-sync');
      socket.off('student-hand-raised'); socket.off('student-hand-lowered');
      socket.off('peer-engagement-stat');
      socket.off('recording-status-change');
      socket.off('peer-joined-notification');
      socket.off('meeting-ended-by-host');
      socket.off('room-passcode');
      socket.off('security-alert');
      socket.disconnect();
    };
  }, [roomId]);

  // ─── Live Mic Voice Volume Detection (Web Audio API) ───
  useEffect(() => {
    if (!userStream || !micOn) {
      setLocalMicVolume(0);
      return;
    }
    let audioCtx;
    let analyser;
    let source;
    let animId;
    let clonedLocalTrack = null;

    try {
      const rawTrack = userStream.getAudioTracks()[0];
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (AudioCtx && rawTrack) {
        audioCtx = new AudioCtx();
        if (audioCtx.state === 'suspended') {
          audioCtx.resume().catch(() => {});
        }
        analyser = audioCtx.createAnalyser();
        analyser.fftSize = 128;
        analyser.smoothingTimeConstant = 0.4;

        // Clone the local track so createMediaStreamSource NEVER steals/intercepts the track from WebRTC peer connection!
        clonedLocalTrack = rawTrack.clone();
        const meterStream = new MediaStream([clonedLocalTrack]);
        source = audioCtx.createMediaStreamSource(meterStream);
        source.connect(analyser);

        const dataArray = new Uint8Array(analyser.frequencyBinCount);
        const checkLevel = () => {
          analyser.getByteFrequencyData(dataArray);
          let sum = 0;
          for (let i = 0; i < dataArray.length; i++) sum += dataArray[i];
          const avg = sum / dataArray.length;
          const score = Math.min(100, Math.round((avg / 128) * 100));
          setLocalMicVolume(score);

          animId = requestAnimationFrame(checkLevel);
        };
        checkLevel();
      }
    } catch (e) {
      console.warn('Local mic volume meter error:', e);
    }

    return () => {
      if (animId) cancelAnimationFrame(animId);
      if (clonedLocalTrack) {
        try { clonedLocalTrack.stop(); } catch(e) {}
      }
      if (audioCtx && audioCtx.state !== 'closed') audioCtx.close();
    };
  }, [userStream, micOn]);

  // ─── Hardware Mic & Speaker Loopback Self-Test ───
  const handleTestMicrophone = () => {
    if (!userStreamRef.current) {
      showToast('No microphone stream available', 'error');
      return;
    }
    if (isMicTesting) {
      setIsMicTesting(false);
      if (micTestAudioRef.current) {
        micTestAudioRef.current.srcObject = null;
      }
      showToast('Mic test stopped');
      return;
    }

    setIsMicTesting(true);
    showToast('🎙️ Mic Loopback Active: Speak to hear yourself in your headphones/speakers!', 'info');
    if (micTestAudioRef.current) {
      micTestAudioRef.current.srcObject = userStreamRef.current;
      micTestAudioRef.current.volume = 1.0;
      micTestAudioRef.current.play().catch(() => {});
    }

    setTimeout(() => {
      setIsMicTesting(false);
      if (micTestAudioRef.current) {
        micTestAudioRef.current.srcObject = null;
      }
    }, 4500);
  };

  // ─── Host Control Action Handlers ───
  const handleHostMuteAll = () => {
    const nextMuted = !isMuteAllActive;
    setIsMuteAllActive(nextMuted);
    socket.emit('host-mute-all', { roomId: cleanRoomId(roomId), isMuted: nextMuted });
    showToast(nextMuted ? '🔇 Muted all participants (Microphones locked)' : '🎙️ Unmuted all participants (Unlocked)');
  };

  const handleHostMuteStudent = (targetSocketId, targetName, shouldMute = true) => {
    socket.emit('host-mute-student', { roomId: cleanRoomId(roomId), targetSocketId, isMuted: shouldMute });
    showToast(shouldMute ? `🔇 Muted & locked ${targetName || 'student'}` : `🎙️ Unlocked ${targetName || 'student'}'s microphone`);
  };

  const handleHostToggleStudentCamera = (targetSocketId, targetName, currentCamOff) => {
    const nextAction = currentCamOff ? 'on' : 'off';
    socket.emit('host-toggle-student-camera', { roomId, targetSocketId, action: nextAction });
    showToast(`📹 Toggled camera for ${targetName || 'student'}`);
  };

  const handleToggleRoomLock = () => {
    const nextLock = !isRoomLocked;
    socket.emit('host-toggle-lock', { roomId, isLocked: nextLock });
    showToast(nextLock ? '🔒 Room Locked (No new students can join)' : '🔓 Room Unlocked');
  };

  const handleRemoveParticipant = (targetSocketId, targetName) => {
    if (window.confirm(`Are you sure you want to remove ${targetName || 'this student'} from the classroom?`)) {
      socket.emit('host-remove-peer', { roomId, targetSocketId });
      showToast(`🚫 Removed ${targetName || 'participant'}`);
    }
  };

  // ─── Category 3: Session Recording with Mobile Fallback & Universal MIME Support ───
  const getRecordingMimeType = () => {
    if (typeof MediaRecorder === 'undefined' || !MediaRecorder.isTypeSupported) {
      return '';
    }
    const candidates = [
      'video/webm;codecs=vp9,opus',
      'video/webm;codecs=vp8,opus',
      'video/webm',
      'video/mp4;codecs=avc1,mp4a.40.2',
      'video/mp4',
      'audio/webm',
      'audio/mp4'
    ];
    for (const type of candidates) {
      if (MediaRecorder.isTypeSupported(type)) {
        return type;
      }
    }
    return '';
  };

  const toggleSessionRecording = async () => {
    if (isRecordingSession) {
      // Stop Recording
      if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
        try {
          mediaRecorderRef.current.stop();
        } catch (e) {
          console.warn('Stop recorder notice:', e);
        }
      }
      setIsRecordingSession(false);
      socket.emit('recording-status-change', {
        roomId,
        isRecording: false,
        recordedByName: user?.name || 'User'
      });
      showToast('⏹️ Recording stopped. Processing and saving...', 'info');
    } else {
      // Start Recording
      try {
        let recordStream = null;
        let isScreenShare = false;
        let isFreshStream = false;

        // 1. Try Desktop Screen Capture first (Supported on PC/Mac)
        if (navigator.mediaDevices && typeof navigator.mediaDevices.getDisplayMedia === 'function') {
          try {
            recordStream = await navigator.mediaDevices.getDisplayMedia({
              video: { frameRate: 30 },
              audio: true
            });
            isScreenShare = true;
            isFreshStream = true;
          } catch (dispErr) {
            console.warn('DisplayMedia capture unavailable or denied on device:', dispErr);
          }
        }

        // 2. Mobile fallback: clone active classroom stream so live lecture feeds are recorded
        if (!recordStream) {
          if (userStreamRef.current && userStreamRef.current.getTracks().length > 0) {
            try {
              recordStream = userStreamRef.current.clone();
              isFreshStream = false;
            } catch (cloneErr) {
              console.warn('userStream clone notice:', cloneErr);
            }
          }
        }

        // 3. Fallback: Acquire fresh camera + audio or audio-only stream for recording
        if (!recordStream && navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
          try {
            recordStream = await navigator.mediaDevices.getUserMedia({
              video: true,
              audio: true
            });
            isFreshStream = true;
          } catch (camErr) {
            console.warn('Camera+mic acquisition failed, attempting audio-only recording:', camErr);
            try {
              recordStream = await navigator.mediaDevices.getUserMedia({ audio: true });
              isFreshStream = true;
            } catch (micErr) {
              console.warn('Audio-only recording also failed:', micErr);
            }
          }
        }

        if (!recordStream) {
          showToast('⚠️ Could not start recording. Please grant camera or microphone permission.', 'error');
          return;
        }

        recordedChunksRef.current = [];
        const detectedMime = getRecordingMimeType();
        const recorderOptions = detectedMime ? { mimeType: detectedMime } : undefined;
        const recorder = new MediaRecorder(recordStream, recorderOptions);

        recorder.ondataavailable = (e) => {
          if (e.data && e.data.size > 0) {
            recordedChunksRef.current.push(e.data);
          }
        };

        recorder.onstop = () => {
          const actualMime = detectedMime || recorder.mimeType || 'video/webm';
          const blob = new Blob(recordedChunksRef.current, { type: actualMime });
          const url = URL.createObjectURL(blob);

          // Check user recording destination preferences
          let prefs = { saveToPc: true, saveToApp: true, storagePath: 'C:\\Users\\PMLS\\Documents\\Zoom' };
          try {
            const saved = localStorage.getItem('synclearn_recording_prefs');
            if (saved) prefs = { ...prefs, ...JSON.parse(saved) };
          } catch (e) {
            console.warn('Prefs read notice:', e);
          }

          const ext = actualMime.includes('mp4') ? 'mp4' : (actualMime.includes('webm') ? 'webm' : 'mp4');
          const fileName = `synclearn-lecture-${roomId || 'session'}-${Date.now()}.${ext}`;

          // 1. Option 1: Device download (PC or Mobile)
          if (prefs.saveToPc) {
            const a = document.createElement('a');
            a.style.display = 'none';
            a.href = url;
            a.download = fileName;
            document.body.appendChild(a);
            a.click();
            setTimeout(() => {
              document.body.removeChild(a);
            }, 300);
          }

          // 2. Option 2: Application me recording k andar save
          if (prefs.saveToApp) {
            try {
              const newRec = {
                id: 'rec-' + Date.now(),
                title: `Class Lecture - Room ${roomId || 'Session'}`,
                roomId: roomId || 'Session',
                date: new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }),
                duration: `${Math.max(1, Math.round(recordedChunksRef.current.length))}s`,
                size: `${(blob.size / (1024 * 1024)).toFixed(1)} MB`,
                recordedBy: user?.name || 'User',
                url: url
              };
              const existing = JSON.parse(localStorage.getItem('synclearn_saved_recordings') || '[]');
              localStorage.setItem('synclearn_saved_recordings', JSON.stringify([newRec, ...existing].slice(0, 15)));
            } catch (err) {
              console.warn('App recording storage notice:', err);
            }
          }

          // Safely stop fresh capture tracks if created exclusively for recording
          if (isFreshStream && recordStream) {
            recordStream.getTracks().forEach(track => {
              try { track.stop(); } catch(e) {}
            });
          }
          setIsRecordingSession(false);

          showToast(`💾 Lecture recorded successfully (${isScreenShare ? 'Full Screen' : 'Live Stream'})! Saved to your device & SyncLearn library.`, 'success');
        };

        // User stops screen capture via browser stop sharing button
        if (isScreenShare && recordStream.getVideoTracks().length > 0) {
          recordStream.getVideoTracks()[0].onended = () => {
            if (recorder.state !== 'inactive') recorder.stop();
          };
        }

        recorder.start(1000); // 1-second chunks
        mediaRecorderRef.current = recorder;
        setIsRecordingSession(true);

        socket.emit('recording-status-change', {
          roomId,
          isRecording: true,
          recordedByName: user?.name || 'Host'
        });
        showToast(isScreenShare ? '⏺️ Recording started (Full Screen)!' : '⏺️ Lecture recording started (Live Session)!');
      } catch (err) {
        console.error('Recording initialization error:', err);
        showToast('⚠️ Could not start recording. Please check browser permissions.', 'error');
        setIsRecordingSession(false);
      }
    }
  };

  // ─── Category 1: Raise Hand Toggle ───
  const toggleRaiseHand = () => {
    const nextState = !hasHandRaised;
    setHasHandRaised(nextState);
    if (nextState) {
      socket.emit('raise-hand', {
        roomId: cleanRoomId(roomId),
        studentName: user?.name || 'Student',
        userId: user?.id || user?._id || socket.id
      });
      showToast('✋ You raised your hand!');
    } else {
      socket.emit('lower-hand', {
        roomId: cleanRoomId(roomId),
        socketId: socket.id,
        userId: user?.id || user?._id || socket.id
      });
      showToast('Hand lowered');
    }
  };

  // ─── Category 1: Student Attention & Focus Telemetry ───
  useEffect(() => {
    const handleVisibilityChange = () => {
      const isFocused = !document.hidden;
      if (socket && roomId) {
        socket.emit('student-engagement-update', {
          roomId,
          studentName: user?.name || 'Student',
          score: isFocused ? 95 : 40,
          isFocused
        });
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [roomId, user]);

  // ─── Coursera-style Gemini Class Coach Handlers ───
  const handleSaveTopic = (newTopicValue) => {
    const freshTopic = (newTopicValue || editTopicVal).trim();
    if (!freshTopic) return;
    setCurrentLectureTopic(freshTopic);
    setIsEditingTopic(false);
    setEditTopicVal('');

    // Emit live topic update to all classroom participants
    if (socket && isConnected) {
      socket.emit('set-room-topic', { roomId, topic: freshTopic });
    }

    try {
      const cleanR = cleanRoomId(roomId);
      localStorage.setItem('synclearn_topic_' + cleanR, freshTopic);
      localStorage.setItem('synclearn_topic_' + cleanR.replace(/-/g, ''), freshTopic);
      localStorage.setItem('synclearn_meeting_topic', freshTopic);
    } catch (e) {}

    showToast(`📌 Topic set to "${freshTopic}" & synced to classroom!`, 'success');
  };

  const handleSendAiPrompt = async (customPromptText = null) => {
    const query = (customPromptText || aiPromptInput).trim();
    if (!query) return;

    const userMsg = {
      id: 'usr_' + Date.now(),
      sender: 'user',
      text: query,
      time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    };

    setAiChatMessages(prev => [...prev, userMsg]);
    if (!customPromptText) setAiPromptInput('');
    setIsAiThinking(true);

    try {
      const lectureContext = transcription.map(t => t.text).join(' ');
      const res = await fetch('/api/v1/ai/gemini-ask', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query,
          topic: currentLectureTopic,
          lectureContext,
          userRole: isInstructor ? 'instructor' : 'student',
          userName: user?.name || (isInstructor ? 'Instructor' : 'Learner')
        })
      });

      const data = await res.json();
      const replyText = data?.answer || `🤖 **Gemini Class Coach**: Explaining "${query}" in the context of "${currentLectureTopic}".`;

      const aiReply = {
        id: 'ai_' + Date.now(),
        sender: 'assistant',
        text: replyText,
        source: data?.source || 'gemini',
        topic: data?.topic || currentLectureTopic,
        time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      };

      setAiChatMessages(prev => [...prev, aiReply]);
    } catch (err) {
      console.warn('Gemini endpoint error, using local tutor engine:', err);
      const fallbackReply = {
        id: 'ai_' + Date.now(),
        sender: 'assistant',
        text: `### 🌟 Gemini Class Coach: **${currentLectureTopic}**\n\nRegarding your query on **${query}**:\n\n1. **Core Concept:** In ${currentLectureTopic}, this principle governs how modules communicate and maintain clean state boundaries.\n2. **Practical Usage:** Always structure your implementation with modular functions and robust edge-case checks.\n3. **Exam / Interview Takeaway:** Focus on real-world scalability and error-handling paradigms.\n\n> 💡 *Live Coach connected to lecture "${currentLectureTopic}". Ask more questions anytime!*`,
        source: 'knowledge-engine',
        topic: currentLectureTopic,
        time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      };
      setAiChatMessages(prev => [...prev, fallbackReply]);
    } finally {
      setIsAiThinking(false);
      setTimeout(() => {
        aiChatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
      }, 100);
    }
  };

  // ─── AI Lecture Summary & Notes Download Handlers ───
  const generateSummaryPoints = (notes) => {
    if (!notes || notes.length === 0) return ['No lecture highlights recorded yet.'];
    const sentences = notes.map(n => n.text).filter(Boolean);
    if (sentences.length <= 3) return sentences;
    const first = sentences[0];
    const mid = sentences[Math.floor(sentences.length / 2)];
    const last = sentences[sentences.length - 1];
    return [first, mid, last].filter((v, i, a) => a.indexOf(v) === i);
  };

  const downloadNotesTXT = () => {
    if (transcription.length === 0) {
      showToast('No notes to download yet!', 'error');
      return;
    }
    let content = `======================================================\n`;
    content += `        SYNCLearn AI Live Lecture Notes & Summary      \n`;
    content += `======================================================\n\n`;
    content += `Room ID:      ${roomId}\n`;
    content += `Date & Time:  ${new Date().toLocaleDateString()} at ${new Date().toLocaleTimeString()}\n`;
    content += `Recorded By:  ${user?.name || 'Instructor'}\n`;
    content += `Total Notes:  ${transcription.length} entries\n\n`;
    content += `------------------------------------------------------\n`;
    content += `KEY HIGHLIGHTS / SUMMARY\n`;
    content += `------------------------------------------------------\n`;
    const summaryPoints = generateSummaryPoints(transcription);
    summaryPoints.forEach((pt, i) => {
      content += `${i + 1}. ${pt}\n`;
    });
    content += `\n------------------------------------------------------\n`;
    content += `CHRONOLOGICAL LECTURE TRANSCRIPT\n`;
    content += `------------------------------------------------------\n\n`;
    transcription.forEach((item, idx) => {
      content += `[${item.time || ''}] ${item.speaker || 'Speaker'}:\n`;
      content += `  ${item.text}\n\n`;
    });
    content += `======================================================\n`;
    content += `Generated automatically by SyncLearn Virtual Classroom\n`;

    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `synclearn-lecture-notes-${roomId || 'session'}.txt`;
    link.click();
    URL.revokeObjectURL(url);
    showToast('📝 Lecture Notes downloaded as TXT!');
  };

  const downloadNotesPDF = () => {
    if (transcription.length === 0) {
      showToast('No notes to download yet!', 'error');
      return;
    }
    try {
      const doc = new jsPDF({
        orientation: 'portrait',
        unit: 'pt',
        format: 'a4'
      });

      const pageWidth = doc.internal.pageSize.getWidth();
      const margin = 40;
      let y = 40;

      // Header Banner
      doc.setFillColor(30, 41, 59);
      doc.rect(0, 0, pageWidth, 75, 'F');

      doc.setFont('helvetica', 'bold');
      doc.setFontSize(18);
      doc.setTextColor(255, 255, 255);
      doc.text('SyncLearn AI Lecture Notes', margin, 38);

      doc.setFontSize(10);
      doc.setTextColor(148, 163, 184);
      doc.text(`Room: ${roomId}  •  Date: ${new Date().toLocaleDateString()}  •  Host: ${user?.name || 'Instructor'}`, margin, 58);

      y = 95;

      // Summary Box
      doc.setFillColor(241, 245, 249);
      doc.setDrawColor(99, 102, 241);
      doc.setLineWidth(1.5);
      doc.roundedRect(margin, y, pageWidth - (margin * 2), 70, 4, 4, 'FD');

      doc.setFont('helvetica', 'bold');
      doc.setFontSize(11);
      doc.setTextColor(67, 56, 202);
      doc.text('💡 Key Lecture Highlights & Takeaways', margin + 12, y + 18);

      doc.setFont('helvetica', 'normal');
      doc.setFontSize(9);
      doc.setTextColor(51, 65, 85);
      const summaryPoints = generateSummaryPoints(transcription);
      summaryPoints.slice(0, 3).forEach((pt, i) => {
        const line = doc.splitTextToSize(`•  ${pt}`, pageWidth - (margin * 2) - 24);
        doc.text(line, margin + 14, y + 34 + (i * 13));
      });

      y += 90;

      // Detailed Notes Section
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(13);
      doc.setTextColor(15, 23, 42);
      doc.text('Detailed Lecture Transcript', margin, y);
      y += 20;

      doc.setFont('helvetica', 'normal');
      doc.setFontSize(9.5);

      transcription.forEach((item) => {
        if (y > doc.internal.pageSize.getHeight() - 55) {
          doc.addPage();
          y = 45;
        }

        doc.setFont('helvetica', 'bold');
        doc.setTextColor(99, 102, 241);
        doc.text(`${item.speaker || 'Speaker'} (${item.time || ''}):`, margin, y);
        y += 13;

        doc.setFont('helvetica', 'normal');
        doc.setTextColor(51, 65, 85);
        const splitText = doc.splitTextToSize(item.text, pageWidth - (margin * 2) - 10);
        doc.text(splitText, margin + 8, y);
        y += (splitText.length * 12) + 8;
      });

      // Footer
      doc.setFontSize(8);
      doc.setTextColor(148, 163, 184);
      doc.text('Generated automatically by SyncLearn — Interactive Virtual Classroom', margin, doc.internal.pageSize.getHeight() - 20);

      doc.save(`synclearn-lecture-notes-${roomId || 'session'}.pdf`);
      showToast('📄 Lecture Notes downloaded as PDF!');
    } catch (err) {
      console.error('PDF export error:', err);
      showToast('Failed to export PDF notes', 'error');
    }
  };

  // ─── Speech-to-Text Recognition & Real-time Lecture Note Broadcasting ───
  const handleToggleSpeechRecognition = () => {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
      showToast('⚠️ Speech recognition is not supported in this browser. You can type notes directly below!', 'info');
      return;
    }

    if (isTranscribing) {
      isTranscribingRef.current = false;
      setIsTranscribing(false);
      if (speechRecognitionRef.current) {
        try { speechRecognitionRef.current.stop(); } catch(e) {}
      }
      showToast('⏸️ Speech transcription paused.', 'info');
    } else {
      try {
        const recognition = new SpeechRecognition();
        recognition.continuous = true;
        recognition.interimResults = false;
        recognition.lang = 'en-US';

        recognition.onresult = (event) => {
          const current = event.resultIndex;
          const transcriptText = event.results[current]?.[0]?.transcript?.trim();
          if (transcriptText) {
            const newEntry = {
              id: 'trans-' + Date.now() + '-' + Math.random().toString(36).substr(2, 4),
              speaker: user?.name || (isInstructor ? 'Instructor' : 'Student'),
              text: transcriptText,
              time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
            };
            setTranscription(prev => [...prev, newEntry]);
            socket.emit('send-transcription', { roomId, entry: newEntry });
          }
        };

        recognition.onerror = (err) => {
          console.warn('Speech recognition notice:', err);
          if (err.error === 'not-allowed') {
            showToast('Microphone access denied for speech recognition.', 'error');
            isTranscribingRef.current = false;
            setIsTranscribing(false);
          }
        };

        recognition.onend = () => {
          if (isTranscribingRef.current) {
            try { recognition.start(); } catch(e) {}
          }
        };

        recognition.start();
        speechRecognitionRef.current = recognition;
        isTranscribingRef.current = true;
        setIsTranscribing(true);
        showToast('🎙️ Live speech transcription started! Spoken words will be transcribed as notes.', 'success');
      } catch (err) {
        console.error('Speech recognition start error:', err);
        showToast('Speech recognition unavailable: ' + (err.message || 'Error'), 'error');
        setIsTranscribing(false);
      }
    }
  };

  // Toggle browser-based live captions. Recreate recognition after each browser
  // speech-service stop; Chrome may end a recognition session during long classes.
  const handleToggleLiveCaptions = () => {
    if (isLiveCaptionsOn) {
      liveCaptionOnRef.current = false;
      setIsLiveCaptionsOn(false);
      if (liveCaptionRestartTimerRef.current) {
        clearTimeout(liveCaptionRestartTimerRef.current);
        liveCaptionRestartTimerRef.current = null;
      }
      if (liveCaptionRecognitionRef.current) {
        const oldRecognition = liveCaptionRecognitionRef.current;
        liveCaptionRecognitionRef.current = null;
        try { oldRecognition.stop(); } catch (e) {}
      }
      setLiveCaptionText('');
      if (liveCaptionClearTimerRef.current) {
        clearTimeout(liveCaptionClearTimerRef.current);
        liveCaptionClearTimerRef.current = null;
      }
      showToast('Live captions turned off.', 'info');
      return;
    }

    // Students only need to enable the display; the instructor sends captions.
    setIsLiveCaptionsOn(true);
    if (!isInstructor) {
      showToast('Captions are on. Instructor speech will appear here when available.', 'success');
      return;
    }

    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
      setIsLiveCaptionsOn(false);
      showToast('Live captions are not supported in this browser. Please use the latest Chrome or Edge.', 'error');
      return;
    }

    liveCaptionOnRef.current = true;

    const startRecognitionSession = () => {
      if (!liveCaptionOnRef.current) return;
      const recognition = new SpeechRecognition();
      recognition.continuous = true;
      recognition.interimResults = true;
      recognition.lang = 'en-US';

      recognition.onresult = (event) => {
        let interimText = '';
        for (let i = event.resultIndex; i < event.results.length; i += 1) {
          const result = event.results[i];
          const phrase = result?.[0]?.transcript?.trim();
          if (!phrase) continue;
          if (result.isFinal) {
            const entry = {
              id: 'caption-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6),
              speaker: user?.name || 'Instructor',
              text: phrase,
              time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
            };
            socket.emit('send-transcription', { roomId: cleanRoomId(roomId), entry });
            setLiveCaptionText(phrase);
            if (liveCaptionClearTimerRef.current) clearTimeout(liveCaptionClearTimerRef.current);
            liveCaptionClearTimerRef.current = setTimeout(() => setLiveCaptionText(''), 6500);
          } else {
            interimText += (interimText ? ' ' : '') + phrase;
          }
        }
        if (interimText) setLiveCaptionText(interimText);
      };

      recognition.onerror = (event) => {
        console.warn('Live caption recognition error:', event?.error || event);
        if (event?.error === 'not-allowed' || event?.error === 'service-not-allowed') {
          liveCaptionOnRef.current = false;
          setIsLiveCaptionsOn(false);
          showToast('Microphone/speech recognition permission was denied.', 'error');
        }
        // For transient errors such as no-speech/network, onend schedules a restart.
      };

      recognition.onend = () => {
        if (liveCaptionRecognitionRef.current === recognition) {
          liveCaptionRecognitionRef.current = null;
        }
        if (liveCaptionOnRef.current) {
          if (liveCaptionRestartTimerRef.current) clearTimeout(liveCaptionRestartTimerRef.current);
          liveCaptionRestartTimerRef.current = setTimeout(() => {
            liveCaptionRestartTimerRef.current = null;
            if (liveCaptionOnRef.current) startRecognitionSession();
          }, 800);
        }
      };

      liveCaptionRecognitionRef.current = recognition;
      try {
        recognition.start();
      } catch (error) {
        console.warn('Could not start live caption recognition; retrying:', error);
        if (liveCaptionRecognitionRef.current === recognition) liveCaptionRecognitionRef.current = null;
        if (liveCaptionOnRef.current) {
          liveCaptionRestartTimerRef.current = setTimeout(() => {
            liveCaptionRestartTimerRef.current = null;
            if (liveCaptionOnRef.current) startRecognitionSession();
          }, 1200);
        }
      }
    };

    try {
      startRecognitionSession();
      showToast('Live captions enabled. Speak into your microphone.', 'success');
    } catch (error) {
      liveCaptionOnRef.current = false;
      setIsLiveCaptionsOn(false);
      console.error('Unable to start live captions:', error);
      showToast('Could not start live captions. Check microphone permission and try again.', 'error');
    }
  };

  const handleAddManualNote = (e) => {
    if (e) e.preventDefault();
    if (!manualNoteInput.trim()) return;
    const newEntry = {
      id: 'manual-' + Date.now(),
      speaker: user?.name || (isInstructor ? 'Instructor' : 'Student'),
      text: manualNoteInput.trim(),
      time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    };
    setTranscription(prev => [...prev, newEntry]);
    socket.emit('send-transcription', { roomId, entry: newEntry });
    setManualNoteInput('');
    showToast('📝 Note added to live lecture notes!');
  };

  // Clean up speech recognition on component unmount
  useEffect(() => {
    return () => {
      isTranscribingRef.current = false;
      if (speechRecognitionRef.current) {
        try { speechRecognitionRef.current.stop(); } catch(e) {}
      }
      liveCaptionOnRef.current = false;
      if (liveCaptionRestartTimerRef.current) clearTimeout(liveCaptionRestartTimerRef.current);
      if (liveCaptionRecognitionRef.current) {
        try { liveCaptionRecognitionRef.current.stop(); } catch(e) {}
      }
      if (liveCaptionClearTimerRef.current) clearTimeout(liveCaptionClearTimerRef.current);
    };
  }, []);

  const iceServersConfig = {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      { urls: 'stun:stun2.l.google.com:19302' },
      { urls: 'stun:stun.cloudflare.com:3478' },
      { urls: 'stun:stun.relay.metered.ca:80' },
      { urls: 'stun:stun.services.mozilla.com' }
    ]
  };

  function createPeer(userToSignal, callerID, stream) {
    const peer = new Peer({ initiator: true, trickle: false, stream, config: iceServersConfig });
    peer.on('signal', signal => socket.emit('sending-signal', { userToSignal, callerID, signal }));
    peer.on('error', err => {
      console.warn('Peer connection error (initiator):', err);
      socket.emit('webrtc-peer-error', { peerId: userToSignal, error: err?.message || String(err), role: isInstructor ? 'instructor' : 'student' });
    });
    if (peer._pc) {
      peer._pc.onconnectionstatechange = () => {
        console.log(`📡 Peer connection state (${userToSignal}):`, peer._pc.connectionState);
        socket.emit('webrtc-peer-state', { peerId: userToSignal, state: peer._pc.connectionState, iceState: peer._pc.iceConnectionState });
        if (peer._pc.connectionState === 'failed') {
          console.log(`🔄 Attempting ICE restart for ${userToSignal}...`);
          try {
            if (peer._pc.restartIce) peer._pc.restartIce();
          } catch(e) {}
        }
      };
      peer._pc.oniceconnectionstatechange = () => {
        console.log(`❄️ Peer ICE state (${userToSignal}):`, peer._pc.iceConnectionState);
        socket.emit('webrtc-peer-state', { peerId: userToSignal, state: peer._pc.connectionState, iceState: peer._pc.iceConnectionState });
        if (peer._pc.iceConnectionState === 'failed') {
          try {
            if (peer._pc.restartIce) peer._pc.restartIce();
          } catch(e) {}
        }
      };
    }
    return peer;
  }

  function addPeer(incomingSignal, callerID, stream) {
    const peer = new Peer({ initiator: false, trickle: false, stream, config: iceServersConfig });
    peer.on('signal', signal => socket.emit('returning-signal', { signal, callerID }));
    peer.on('error', err => {
      console.warn('Peer connection error (receiver):', err);
      socket.emit('webrtc-peer-error', { peerId: callerID, error: err?.message || String(err), role: isInstructor ? 'instructor' : 'student' });
    });
    if (peer._pc) {
      peer._pc.onconnectionstatechange = () => {
        console.log(`📡 Peer connection state (${callerID}):`, peer._pc.connectionState);
        socket.emit('webrtc-peer-state', { peerId: callerID, state: peer._pc.connectionState, iceState: peer._pc.iceConnectionState });
        if (peer._pc.connectionState === 'failed') {
          try {
            if (peer._pc.restartIce) peer._pc.restartIce();
          } catch(e) {}
        }
      };
      peer._pc.oniceconnectionstatechange = () => {
        console.log(`❄️ Peer ICE state (${callerID}):`, peer._pc.iceConnectionState);
        socket.emit('webrtc-peer-state', { peerId: callerID, state: peer._pc.connectionState, iceState: peer._pc.iceConnectionState });
        if (peer._pc.iceConnectionState === 'failed') {
          try {
            if (peer._pc.restartIce) peer._pc.restartIce();
          } catch(e) {}
        }
      };
    }
    peer.signal(incomingSignal);
    return peer;
  }

  const findAudioSender = (pc) => {
    if (!pc) return null;
    const senders = pc.getSenders ? pc.getSenders() : [];
    let s = senders.find(x => x.track && x.track.kind === 'audio');
    if (s) return s;
    const transceivers = pc.getTransceivers ? pc.getTransceivers() : [];
    const t = transceivers.find(x => 
      (x.sender?.track && x.sender.track.kind === 'audio') ||
      (x.receiver?.track && x.receiver.track.kind === 'audio') ||
      x.mid === '0' || x.mid === 'audio'
    );
    if (t?.sender) return t.sender;
    s = senders.find(x => x.dtmf !== undefined && x.dtmf !== null);
    if (s) return s;
    return senders.find(x => !x.track || x.track.kind !== 'video') || null;
  };

  const findVideoSender = (pc) => {
    if (!pc) return null;
    const senders = pc.getSenders ? pc.getSenders() : [];
    let s = senders.find(x => x.track && x.track.kind === 'video');
    if (s) return s;
    const transceivers = pc.getTransceivers ? pc.getTransceivers() : [];
    const t = transceivers.find(x => 
      (x.sender?.track && x.sender.track.kind === 'video') ||
      (x.receiver?.track && x.receiver.track.kind === 'video') ||
      x.mid === '1' || x.mid === 'video'
    );
    if (t?.sender) return t.sender;
    return senders.find(x => !x.dtmf && (!x.track || x.track.kind !== 'audio')) || null;
  };

  const toggleMic = async () => {
    if (!isInstructor && isMutedByHost) {
      showToast('⚠️ Microphone is locked by the instructor. You cannot unmute yourself.', 'error');
      return;
    }
    const nextMic = !micOn;

    if (nextMic) {
      // 1. If an existing live audio track is already available AND is NOT synthetic/silent, re-enable it immediately
      const existingAudioTrack = userStreamRef.current?.getAudioTracks()[0];
      if (existingAudioTrack && existingAudioTrack.readyState === 'live' && !existingAudioTrack._isSilentTrack) {
        existingAudioTrack.enabled = true;
        peersRef.current.forEach(p => {
          try {
            if (typeof p.peer?.replaceTrack === 'function') {
              try {
                const oldTracks = p.peer.streams?.[0]?.getAudioTracks() || [];
                oldTracks.forEach(ot => {
                  try { p.peer.replaceTrack(ot, existingAudioTrack, userStreamRef.current); } catch(e) {}
                });
              } catch(e) {}
            }
            const pc = p.peer?._pc;
            if (pc) {
              const sender = findAudioSender(pc);
              if (sender) {
                if (sender.track) sender.track.enabled = true;
                sender.replaceTrack(existingAudioTrack).catch(() => {});
              }
            }
          } catch (e) {
            console.warn('Error syncing existing audio track to peer:', e);
          }
        });

        setUserStream(new MediaStream(userStreamRef.current.getTracks()));
        setMicOn(true);
        socket.emit('media-state-change', { roomId: cleanRoomId(roomId), videoOn, micOn: true });
        showToast('🎤 Microphone is live!');
        return;
      }

      // 2. Otherwise acquire fresh hardware audio track
      try {
        let audioStream;
        try {
          audioStream = await navigator.mediaDevices.getUserMedia({
            audio: selectedMicId && selectedMicId !== 'default' && selectedMicId !== 'system'
              ? { deviceId: { exact: selectedMicId }, echoCancellation: true, noiseSuppression: true, autoGainControl: true }
              : { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
          });
        } catch (e) {
          audioStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        }

        const newAudioTrack = audioStream?.getAudioTracks()[0];
        if (newAudioTrack) {
          newAudioTrack.enabled = true;
          const oldAudioTracks = userStreamRef.current ? [...userStreamRef.current.getAudioTracks()] : [];
          if (userStreamRef.current) {
            userStreamRef.current.getAudioTracks().forEach(t => {
              try { t.stop(); } catch (e) {}
              userStreamRef.current.removeTrack(t);
            });
            userStreamRef.current.addTrack(newAudioTrack);
          }

          // Force replaceTrack on all peer connections so real audio packets flow immediately
          peersRef.current.forEach(p => {
            try {
              if (typeof p.peer?.replaceTrack === 'function' && oldAudioTracks.length > 0) {
                oldAudioTracks.forEach(ot => {
                  try { p.peer.replaceTrack(ot, newAudioTrack, userStreamRef.current); } catch(e) {}
                });
              }
              const pc = p.peer?._pc;
              if (pc) {
                const sender = findAudioSender(pc);
                if (sender) {
                  sender.replaceTrack(newAudioTrack).catch(() => {});
                } else if (typeof pc.addTrack === 'function') {
                  try { pc.addTrack(newAudioTrack, userStreamRef.current); } catch(e) {}
                }
              }
            } catch (e) {
              console.warn('Error replacing audio track on peer:', e);
            }
          });

          setUserStream(new MediaStream(userStreamRef.current.getTracks()));
          setMicOn(true);
          socket.emit('media-state-change', { roomId: cleanRoomId(roomId), videoOn, micOn: true });
          showToast('🎤 Microphone is live!');
          return;
        }
      } catch (err) {
        console.warn('Microphone permission or hardware error:', err);
        showToast('⚠️ Microphone permission required. Please allow mic in browser settings.');
        return;
      }
    } else {
      // User turns mic OFF - strictly disable all audio tracks and WebRTC senders
      if (userStreamRef.current) {
        userStreamRef.current.getAudioTracks().forEach(t => {
          t.enabled = false;
        });
      }
      peersRef.current.forEach(p => {
        try {
          const pc = p.peer?._pc;
          if (pc) {
            const sender = findAudioSender(pc);
            if (sender && sender.track) {
              sender.track.enabled = false;
            }
          }
        } catch (e) {}
      });
      setMicOn(false);
      socket.emit('media-state-change', { roomId: cleanRoomId(roomId), videoOn, micOn: false });
      showToast('🔇 Microphone muted');
    }
  };

  const toggleVideo = async () => {
    const nextVideo = !videoOn;

    if (nextVideo) {
      // 1. If an existing live video track is already available AND is NOT synthetic, re-enable it immediately
      const existingVideoTrack = userStreamRef.current?.getVideoTracks()[0];
      if (existingVideoTrack && existingVideoTrack.readyState === 'live' && !existingVideoTrack._isSynthetic) {
        existingVideoTrack.enabled = true;
        peersRef.current.forEach(p => {
          try {
            const pc = p.peer?._pc;
            if (pc) {
              const sender = findVideoSender(pc);
              if (sender) {
                sender.replaceTrack(existingVideoTrack).catch(() => {});
              }
            }
          } catch (e) {
            console.warn('Error syncing existing video track to peer:', e);
          }
        });

        setUserStream(new MediaStream(userStreamRef.current.getTracks()));
        setVideoOn(true);
        socket.emit('media-state-change', { roomId: cleanRoomId(roomId), videoOn: true, micOn });
        showToast('📹 Camera connected!');
        return;
      }

      // 2. Otherwise acquire fresh hardware camera track or synthetic fallback
      let newTrack = null;
      try {
        const camStream = await navigator.mediaDevices.getUserMedia({
          video: selectedCameraId && selectedCameraId !== 'default' && selectedCameraId !== 'system-cam'
            ? { deviceId: { exact: selectedCameraId } }
            : true
        });
        newTrack = camStream?.getVideoTracks()[0];
      } catch (err) {
        console.warn('Physical camera unavailable, seamlessly injecting synthetic canvas stream fallback:', err);
      }

      // If physical webcam is unavailable or in use by another tab/app, generate animated fallback so screen is NEVER black!
      if (!newTrack) {
        try {
          const fallback = createFallbackStream(user?.name, isInstructor);
          if (fallback) {
            newTrack = fallback.getVideoTracks()[0];
            if (newTrack) newTrack._isSynthetic = true;
          }
        } catch (e) {
          console.warn('Fallback stream error:', e);
        }
      }

      if (newTrack) {
        newTrack.enabled = true;
        if (userStreamRef.current) {
          userStreamRef.current.getVideoTracks().forEach(t => {
            try { t.stop(); } catch (e) {}
            userStreamRef.current.removeTrack(t);
          });
          userStreamRef.current.addTrack(newTrack);
        }
        cameraTrackRef.current = newTrack;
        peersRef.current.forEach(p => {
          try {
            const pc = p.peer?._pc;
            if (pc) {
              const sender = findVideoSender(pc);
              if (sender) {
                sender.replaceTrack(newTrack).catch(() => {});
              } else if (p.peer?.addTrack) {
                p.peer.addTrack(newTrack, userStreamRef.current);
              }
            }
          } catch (e) {
            console.warn('Error replacing video track on peer:', e);
          }
        });
        setUserStream(new MediaStream(userStreamRef.current.getTracks()));
        setVideoOn(true);
        socket.emit('media-state-change', { roomId: cleanRoomId(roomId), videoOn: true, micOn });
        showToast(newTrack._isSynthetic ? '🎨 Virtual camera stream active' : '📹 Camera connected!');
        return;
      }
    } else {
      // User turns video OFF
      const track = userStreamRef.current?.getVideoTracks()[0];
      if (track) {
        track.enabled = false;
      }
      setVideoOn(false);
      socket.emit('media-state-change', { roomId: cleanRoomId(roomId), videoOn: false, micOn });
      showToast('🚫 Camera turned off');
    }
  };

  // ─── Live Chat, Doubts & File Sharing Handlers ───
  const handleFileSelect = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (file.size > 3 * 1024 * 1024) {
      showToast('File size must be under 3MB', 'error');
      return;
    }

    const reader = new FileReader();
    reader.onload = () => {
      setSelectedFile({
        name: file.name,
        type: file.type,
        size: (file.size / 1024).toFixed(1) + ' KB',
        dataUrl: reader.result,
        isImage: file.type.startsWith('image/')
      });
      showToast(`📎 Attached: ${file.name}`);
    };
    reader.readAsDataURL(file);
    e.target.value = null;
  };

  const handleToggleChatLock = () => {
    if (!isInstructor) return;
    const nextLocked = !isChatLocked;
    setIsChatLocked(nextLocked);
    const cleanRoom = cleanRoomId(roomId);
    socket.emit('toggle-chat-lock', { roomId: cleanRoom, isLocked: nextLocked });
    showToast(nextLocked ? '🔒 Student chat is now locked' : '🔓 Student chat is unlocked');
  };

  const sendMessage = (e) => {
    e.preventDefault();
    if (!isInstructor && isChatLocked) {
      showToast('🔒 Chat has been locked by the teacher.', 'error');
      return;
    }
    if (!newMessage.trim() && !selectedFile) return;

    const msgPayload = {
      roomId,
      id: 'msg_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4),
      message: newMessage.trim(),
      senderId: socket.id,
      senderName: user?.name || (isInstructor ? 'Instructor' : 'Student'),
      senderRole: user?.role || 'student',
      isDoubt: isDoubtMode,
      file: selectedFile,
    };

    socket.emit('send-message', msgPayload);

    // If marked as doubt, auto-pin to room
    if (isDoubtMode) {
      const doubtItem = {
        id: msgPayload.id,
        senderName: msgPayload.senderName,
        senderRole: msgPayload.senderRole,
        text: newMessage.trim() || (selectedFile ? `[File: ${selectedFile.name}]` : 'Doubt question'),
        time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      };
      socket.emit('pin-doubt', { roomId, doubt: doubtItem });
      setIsDoubtMode(false);
    }

    setNewMessage('');
    setSelectedFile(null);
  };

  // Synchronized Workspace View Switching (Instructor sets view for all, or local override)
  const handleSetWorkspaceView = (newView, broadcast = true) => {
    setWorkspaceView(newView);
    if (broadcast && isInstructor) {
      const cleanRoom = cleanRoomId(roomId);
      socket.emit('workspace-view-sync', { roomId: cleanRoom, view: newView });
    }
  };

  const handleJumpToVideoMoment = (timestamp, formattedTime) => {
    handleSetWorkspaceView('video', true);
    const cleanRoom = cleanRoomId(roomId);
    socket.emit('seek-to-video-time', { roomId: cleanRoom, timestamp });
    showToast(`🎬 Video sought to ${formattedTime || Math.floor(timestamp) + 's'}`);
  };

  const handleAddPinnedDoubt = (doubt) => {
    if (!doubt) return;
    setPinnedDoubts(prev => {
      if (prev.some(d => d.id === doubt.id)) return prev;
      return [doubt, ...prev];
    });
    const cleanRoom = cleanRoomId(roomId);
    socket.emit('pin-doubt', { roomId: cleanRoom, doubt });

    // CRITICAL: Automatically post this doubt question into the live Room Chat!
    const doubtChatMsg = {
      id: doubt.id || ('doubt_msg_' + Date.now()),
      roomId: cleanRoom,
      senderName: doubt.senderName || (isInstructor ? 'Instructor' : 'Student'),
      senderRole: doubt.senderRole || 'student',
      message: doubt.text,
      doubtQuestion: doubt.text,
      videoTimestamp: doubt.videoTimestamp,
      videoTimeFormatted: doubt.videoTimeFormatted,
      isDoubt: true,
      doubtId: doubt.id,
      time: doubt.time || new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    };
    socket.emit('send-message', doubtChatMsg);
    showToast(`📍 Doubt question pinned & sent to Instructor in Chat! (${doubt.videoTimeFormatted || 'video'})`, 'success');
  };

  const handlePinDoubt = (msg) => {
    const alreadyPinned = pinnedDoubts.some(d => d.id === msg.id);
    if (alreadyPinned) {
      showToast('Already pinned as doubt');
      return;
    }
    const doubt = {
      id: msg.id || ('doubt_' + Date.now()),
      senderName: msg.senderName || 'Student',
      senderRole: msg.senderRole || 'student',
      text: msg.message || (msg.file ? `[Attachment: ${msg.file.name}]` : 'Doubt question'),
      time: msg.time || new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      videoTimestamp: typeof msg.videoTimestamp === 'number' ? msg.videoTimestamp : undefined,
      videoTimeFormatted: msg.videoTimeFormatted || undefined,
    };
    setPinnedDoubts(prev => [doubt, ...prev]);
    const cleanRoom = cleanRoomId(roomId);
    socket.emit('pin-doubt', { roomId: cleanRoom, doubt });
    showToast('📌 Doubt pinned to room!');
  };

  const handleResolveDoubt = (doubtId) => {
    setPinnedDoubts(prev => prev.filter(d => d.id !== doubtId));
    const cleanRoom = cleanRoomId(roomId);
    socket.emit('resolve-doubt', { roomId: cleanRoom, doubtId });

    // Post an affirmative resolve confirmation in chat
    socket.emit('send-message', {
      id: 'resolve_notice_' + Date.now(),
      roomId: cleanRoom,
      senderName: user?.name || (isInstructor ? 'Instructor' : 'Host'),
      senderRole: isInstructor ? 'instructor' : 'student',
      message: `✅ Instructor marked doubt question as RESOLVED.`,
      isResolvedNotice: true,
      resolvedDoubtId: doubtId,
      time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    });

    showToast('✅ Doubt marked as resolved');
  };

  const downloadChatHistory = () => {
    if (messages.length === 0) {
      showToast('No chat messages to export', 'error');
      return;
    }
    let content = `======================================================\n`;
    content += `         SyncLearn Classroom Live Chat Transcript     \n`;
    content += `======================================================\n\n`;
    content += `Room ID:        ${roomId}\n`;
    content += `Date & Time:    ${new Date().toLocaleDateString()} at ${new Date().toLocaleTimeString()}\n`;
    content += `Exported By:    ${user?.name || 'User'}\n`;
    content += `Total Messages: ${messages.length}\n\n`;
    content += `------------------------------------------------------\n\n`;

    messages.forEach(m => {
      const roleStr = m.senderRole ? ` [${m.senderRole.toUpperCase()}]` : '';
      const doubtStr = m.isDoubt ? ' [❓ DOUBT]' : '';
      content += `[${m.time || ''}] ${m.senderName || 'User'}${roleStr}${doubtStr}:\n`;
      if (m.message) content += `  ${m.message}\n`;
      if (m.file) content += `  [Attached File: ${m.file.name} (${m.file.size})]\n`;
      content += `\n`;
    });

    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `synclearn-chat-${roomId || 'session'}.txt`;
    link.click();
    URL.revokeObjectURL(url);
    showToast('📥 Chat log downloaded as TXT!');
  };

  const handleAdmitStudent = (studentSocketId) => {
    socket.emit('admit-student', { roomId: cleanRoomId(roomId), targetSocketId: studentSocketId });
    setPendingAdmissionRequests(prev => prev.filter(s => s.socketId !== studentSocketId));
    if (currentAdmissionPrompt?.socketId === studentSocketId) {
      setCurrentAdmissionPrompt(null);
    }
    showToast('✅ Student admitted to classroom');
  };

  const handleDenyStudent = (studentSocketId) => {
    socket.emit('deny-student', { roomId: cleanRoomId(roomId), targetSocketId: studentSocketId });
    setPendingAdmissionRequests(prev => prev.filter(s => s.socketId !== studentSocketId));
    if (currentAdmissionPrompt?.socketId === studentSocketId) {
      setCurrentAdmissionPrompt(null);
    }
    showToast('❌ Student admission denied', 'error');
  };

  const handleAdmitAllStudents = () => {
    socket.emit('admit-all-students', { roomId: cleanRoomId(roomId) });
    setPendingAdmissionRequests([]);
    setCurrentAdmissionPrompt(null);
    showToast('✅ All pending students admitted');
  };

  return (
    <div className="room-container" data-theme={theme}>
      {/* ── Floating Toast Notification ── */}
      {toast.show && (
        <div className={`synclearn-toast ${toast.type === 'error' ? 'toast-error' : ''}`}>
          <div className="toast-content">
            <span className="toast-icon">{toast.type === 'error' ? '⚠️' : '✅'}</span>
            <span>{toast.message}</span>
          </div>
        </div>
      )}

      {/* ── Live Captions Overlay ── */}
      {liveCaptionText && (
        <div
          role="status"
          aria-live="polite"
          className="synclearn-live-captions"
          style={{
            position: 'fixed',
            left: '50%',
            bottom: '108px',
            transform: 'translateX(-50%)',
            width: 'min(82vw, 900px)',
            zIndex: 99990,
            padding: '12px 20px',
            borderRadius: '12px',
            background: 'rgba(2, 6, 23, 0.88)',
            color: '#fff',
            textAlign: 'center',
            fontSize: 'clamp(15px, 1.8vw, 22px)',
            fontWeight: 600,
            lineHeight: 1.45,
            textShadow: '0 1px 2px rgba(0,0,0,.5)',
            boxShadow: '0 8px 28px rgba(0,0,0,.28)',
            pointerEvents: 'none',
            overflowWrap: 'anywhere'
          }}
        >
          <span style={{ display: 'block', color: '#67e8f9', fontSize: '11px', letterSpacing: '0.12em', textTransform: 'uppercase', marginBottom: '3px' }}>LIVE CAPTIONS</span>
          {liveCaptionText}
        </div>
      )}

      {/* ── Security Alert: Real-Time Silent Drop on Unauthorized Access Attempts ── */}
      {isInstructor && activeSecurityAlert && (
        <div
          className="admission-alert-popup security-alert-drop"
          style={{
            position: 'fixed',
            top: '20px',
            left: '50%',
            transform: 'translateX(-50%)',
            zIndex: 99999,
            background: 'linear-gradient(135deg, #1e1b4b 0%, #0f172a 100%)',
            border: '2px solid #ef4444',
            borderRadius: '16px',
            padding: '12px 20px',
            boxShadow: '0 14px 44px rgba(0, 0, 0, 0.75), 0 0 24px rgba(239, 68, 68, 0.45)',
            display: 'flex',
            alignItems: 'center',
            gap: '16px',
            minWidth: '380px',
            maxWidth: '92vw'
          }}
        >
          <div
            style={{
              width: '42px',
              height: '42px',
              borderRadius: '50%',
              background: 'linear-gradient(135deg, #ef4444, #b91c1c)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: '1.3rem',
              color: '#fff',
              flexShrink: 0,
              boxShadow: '0 0 16px rgba(239, 68, 68, 0.5)'
            }}
          >
            🛡️
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '2px' }}>
              <span style={{ fontSize: '0.70rem', textTransform: 'uppercase', letterSpacing: '0.06em', background: 'rgba(239, 68, 68, 0.2)', color: '#f87171', padding: '2px 8px', borderRadius: '4px', fontWeight: 800 }}>
                Security Alert • Blocked
              </span>
              <span style={{ fontSize: '0.70rem', color: '#94a3b8' }}>
                {new Date(activeSecurityAlert.timestamp || Date.now()).toLocaleTimeString()}
              </span>
            </div>
            <div style={{ fontSize: '0.92rem', fontWeight: 700, color: '#f8fafc', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              Unauthorized attempt by <span style={{ color: '#f87171' }}>{activeSecurityAlert.userName}</span> was blocked.
            </div>
            <div style={{ fontSize: '0.76rem', color: '#cbd5e1', marginTop: '2px' }}>
              Attempted Passcode: <code style={{ background: 'rgba(0,0,0,0.3)', padding: '1px 5px', borderRadius: '4px', color: '#fca5a5' }}>{activeSecurityAlert.attemptedPasscode}</code>
            </div>
          </div>
          <button
            type="button"
            onClick={() => setActiveSecurityAlert(null)}
            style={{
              background: 'rgba(255, 255, 255, 0.1)',
              color: '#e2e8f0',
              border: 'none',
              borderRadius: '8px',
              padding: '6px 12px',
              fontWeight: 700,
              fontSize: '0.80rem',
              cursor: 'pointer'
            }}
            title="Dismiss Alert"
          >
            ✕ Dismiss
          </button>
        </div>
      )}

      {/* Optional fallback for manual admission if used */}
      {isInstructor && currentAdmissionPrompt && !activeSecurityAlert && (
        <div
          className="admission-alert-popup"
          style={{
            position: 'fixed',
            top: '20px',
            left: '50%',
            transform: 'translateX(-50%)',
            zIndex: 99999,
            background: 'linear-gradient(135deg, #0f172a 0%, #1e293b 100%)',
            border: '2px solid #06b6d4',
            borderRadius: '16px',
            padding: '14px 22px',
            boxShadow: '0 14px 44px rgba(0, 0, 0, 0.75), 0 0 28px rgba(6, 182, 212, 0.45)',
            display: 'flex',
            alignItems: 'center',
            gap: '18px',
            minWidth: '380px',
            maxWidth: '92vw'
          }}
        >
          <div
            style={{
              width: '46px',
              height: '46px',
              borderRadius: '50%',
              background: 'linear-gradient(135deg, #06b6d4, #0284c7)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: '1.4rem',
              color: '#fff',
              flexShrink: 0,
              boxShadow: '0 0 16px rgba(6, 182, 212, 0.6)'
            }}
          >
            🔔
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '3px' }}>
              <span style={{ fontSize: '0.72rem', textTransform: 'uppercase', letterSpacing: '0.06em', background: 'rgba(6, 182, 212, 0.2)', color: '#38bdf8', padding: '2px 8px', borderRadius: '4px', fontWeight: 800 }}>
                Waiting Room
              </span>
              {pendingAdmissionRequests.length > 1 && (
                <span style={{ fontSize: '0.72rem', color: '#94a3b8' }}>
                  +{pendingAdmissionRequests.length - 1} more waiting
                </span>
              )}
            </div>
            <div style={{ fontSize: '0.96rem', fontWeight: 800, color: '#f8fafc', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              Student <span style={{ color: '#38bdf8' }}>{currentAdmissionPrompt.userName}</span> is trying to join the class.
            </div>
            <div style={{ fontSize: '0.78rem', color: '#94a3b8', marginTop: '2px' }}>
              Allow or Deny entry into the classroom session?
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexShrink: 0 }}>
            <button
              type="button"
              onClick={() => handleAdmitStudent(currentAdmissionPrompt.socketId)}
              style={{
                background: 'linear-gradient(135deg, #10b981 0%, #059669 100%)',
                color: '#fff',
                border: 'none',
                borderRadius: '8px',
                padding: '8px 16px',
                fontWeight: 800,
                fontSize: '0.86rem',
                cursor: 'pointer',
                boxShadow: '0 4px 14px rgba(16, 185, 129, 0.4)',
                display: 'flex',
                alignItems: 'center',
                gap: '5px'
              }}
            >
              ✓ Allow
            </button>
            <button
              type="button"
              onClick={() => handleDenyStudent(currentAdmissionPrompt.socketId)}
              style={{
                background: 'rgba(239, 68, 68, 0.15)',
                color: '#ef4444',
                border: '1.5px solid #ef4444',
                borderRadius: '8px',
                padding: '7px 14px',
                fontWeight: 700,
                fontSize: '0.86rem',
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                gap: '5px'
              }}
            >
              ✕ Deny
            </button>
          </div>
        </div>
      )}



      {/* ── Header ── */}
      <header className="room-header">
        <div className="room-info"> 

          <h2 className="room-header-title">
            <img src="/logo.png" alt="SyncLearn" className="room-header-logo" />
            <span className="logo-text">SyncLearn</span>
          </h2>
          <span className="status-indicator">
            {isConnected ? '🟢 Live' : '🔴 Connecting...'}
          </span>

          <span className="room-roster-count-chip" title="Real-time students & teacher connected now">
            👥 {participants.length || 1} Online
          </span>

          {isInstructor && (
            <span className="instructor-host-badge" title="You are the session host">
              👨‍🏫 Host
            </span>
          )}

          {isRoomLocked && (
            <span className="room-locked-chip" title="Room is currently locked by instructor">
              🔒 Locked
            </span>
          )}

          {/* Recording Notice Badge */}
          {(isRecordingSession || remoteRecordingNotice?.isRecording) && (
            <span className="recording-indicator-chip" title="Live lecture screen recording in progress">
              <span className="recording-dot"></span>
              <span>REC</span>
            </span>
          )}
        </div>

        <div className='nav-links'> 
          {/* Mobile Menu Toggle Button */}
          <button
            type="button"
            className="mobile-sidebar-toggle-btn"
            onClick={() => setIsSidebarCollapsed(prev => !prev)}
            title="Toggle Classroom Tools Menu"
            aria-label="Toggle Classroom Tools"
          >
            ☰
          </button>
          <button
            type="button"
            className="theme-icon-btn"
            onClick={onToggleTheme}
            title={theme === 'dark' ? 'Switch to Light Mode ☀️' : 'Switch to Dark Mode 🌙'}
            aria-label="Toggle Theme"
          >
            {theme === 'dark' ? '☀️' : '🌙'}
          </button>
          {/* Header 3-Dots Action Menu (Image 5) */}
          <div className="header-more-actions" style={{ position: 'relative' }}>
            <button 
              type="button" 
              className="header-dots-btn" 
              onClick={(e) => {
                e.stopPropagation();
                setIsHeaderMenuOpen(prev => !prev);
              }}
              title="Session Actions (⋮)"
              aria-label="Classroom actions menu"
            >
              ⋮
            </button>

            {isHeaderMenuOpen && (
              <div className="header-dropdown-menu" onClick={e => e.stopPropagation()}>
                {isInstructor ? (
                  <>
                    <button
                      type="button"
                      className="header-dropdown-item end-all-item"
                      onClick={() => {
                        setIsHeaderMenuOpen(false);
                        socket.emit('end-meeting-for-all', { roomId: cleanRoomId(roomId) });
                        handleRecordSessionHistoryAndLeave();
                      }}
                      title="End meeting for all participants"
                    >
                      <span style={{ fontSize: '1.15rem' }}>🛑</span>
                      <div style={{ textAlign: 'left' }}>
                        <div style={{ fontWeight: 800, color: '#fca5a5', fontSize: '0.85rem' }}>End Meeting for All</div>
                        <div style={{ fontSize: '0.7rem', color: '#94a3b8' }}>Disconnect everyone & end class</div>
                      </div>
                    </button>
                    <button
                      type="button"
                      className="header-dropdown-item leave-item"
                      onClick={() => {
                        setIsHeaderMenuOpen(false);
                        handleRecordSessionHistoryAndLeave();
                      }}
                      title="Leave meeting and return to dashboard"
                    >
                      <span style={{ fontSize: '1.15rem' }}>⬅️</span>
                      <div style={{ textAlign: 'left' }}>
                        <div style={{ fontWeight: 700, color: '#e2e8f0', fontSize: '0.85rem' }}>Leave Meeting</div>
                        <div style={{ fontSize: '0.7rem', color: '#94a3b8' }}>Exit room (keep session running)</div>
                      </div>
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    className="header-dropdown-item leave-item"
                    onClick={() => {
                      setIsHeaderMenuOpen(false);
                      handleRecordSessionHistoryAndLeave();
                    }}
                    title="Leave meeting and return to dashboard"
                  >
                    <span style={{ fontSize: '1.15rem' }}>⬅️</span>
                    <div style={{ textAlign: 'left' }}>
                      <div style={{ fontWeight: 700, color: '#e2e8f0', fontSize: '0.85rem' }}>Leave Meeting</div>
                      <div style={{ fontSize: '0.7rem', color: '#94a3b8' }}>Exit classroom</div>
                    </div>
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
      </header>

      {/* ── Body ── */}
      <div className={`room-body ${activeTab ? 'sidebar-open' : 'sidebar-closed'} ${isSidebarCollapsed ? 'left-dock-collapsed' : 'left-dock-expanded'} sidebar-${panelSizeMode}`}>
        {/* Mobile Backdrop to close drawer when tapping outside */}
        {!isSidebarCollapsed && (
          <div
            className="studio-dock-mobile-backdrop"
            onClick={() => setIsSidebarCollapsed(true)}
            aria-hidden="true"
          />
        )}

        {/* ── Left Collapsible Navigation Dock (Matching Images 1, 2, 3) ── */}
        <aside className={`studio-dock-sidebar ${isSidebarCollapsed ? 'collapsed' : 'expanded'}`}>
          {/* Header with 3 Lines Hamburger Menu Button (Image 3) */}
          <div className="sidebar-top-header">
            <button
              type="button"
              className="sidebar-hamburger-btn"
              onClick={() => {
                setIsSidebarCollapsed(prev => {
                  const next = !prev;
                  if (!next) {
                    setActiveCategory(null);
                  }
                  return next;
                });
              }}
              title={isSidebarCollapsed ? "Expand Sidebar (≡)" : "Collapse Sidebar to Icons (≡)"}
            >
              <span className="hamburger-bars">
                <span className="bar"></span>
                <span className="bar"></span>
                <span className="bar"></span>
              </span>
            </button>
            {!isSidebarCollapsed && (
              <>
                <div className="sidebar-brand-title">
                  <span className="brand-dot"></span>
                  <span className="brand-text">Classroom Studio</span>
                </div>
                <button
                  type="button"
                  className="sidebar-mobile-close-btn"
                  onClick={() => setIsSidebarCollapsed(true)}
                  title="Close Menu (✕)"
                  aria-label="Close Menu"
                >
                  ✕
                </button>
              </>
            )}
          </div>

          {/* Scrollable Items Column */}
          <div className="sidebar-scroll-items">
            {isSidebarCollapsed ? (
              /* Collapsed Mode (Image 4): Exactly 4 Main Category Icons */
              <div className="sidebar-collapsed-icons-group">
                <button
                  type="button"
                  className={`sidebar-nav-item ${activeCategory === 'workspace' ? 'active' : ''}`}
                  onClick={() => {
                    setIsSidebarCollapsed(false);
                    setActiveCategory('workspace');
                  }}
                  title="Workspaces (Dual Whiteboard, Video, All-In-One, Cameras)"
                >
                  <span className="sidebar-item-icon" style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                      <rect x="3" y="3" width="7" height="7" rx="1.5" />
                      <rect x="14" y="3" width="7" height="7" rx="1.5" />
                      <rect x="14" y="14" width="7" height="7" rx="1.5" />
                      <rect x="3" y="14" width="7" height="7" rx="1.5" />
                    </svg>
                  </span>
                </button>

                <button
                  type="button"
                  className={`sidebar-nav-item ${activeCategory === 'tools' ? 'active' : ''}`}
                  onClick={() => {
                    setIsSidebarCollapsed(false);
                    setActiveCategory('tools');
                  }}
                  title="Tools & Apps (AI Tutor, Quiz, Notes, CC)"
                >
                  <span className="sidebar-item-icon">🛠️</span>
                </button>

                {isInstructor && (
                  <button
                    type="button"
                    className={`sidebar-nav-item ${activeCategory === 'host' ? 'active' : ''}`}
                    onClick={() => {
                      setIsSidebarCollapsed(false);
                      setActiveCategory('host');
                    }}
                    title="Host Controls & Management"
                  >
                    <span className="sidebar-item-icon">👑</span>
                  </button>
                )}

                <button
                  type="button"
                  className="sidebar-nav-item"
                  onClick={() => onOpenSettings && onOpenSettings('general')}
                  title="Settings (Audio, Video, Theme)"
                >
                  <span className="sidebar-item-icon">⚙️</span>
                </button>
              </div>
            ) : (
              /* Expanded Mode (Image 3): 4 Categories with Icon + Name & Accordion Content */
              <div className="sidebar-categories-accordion">
                {/* 1. Workspaces Category */}
                <div className="sidebar-category-group">
                  <button
                    type="button"
                    className={`sidebar-category-header ${activeCategory === 'workspace' ? 'category-active' : ''}`}
                    onClick={() => setActiveCategory(prev => prev === 'workspace' ? null : 'workspace')}
                    title="Click to expand/collapse Workspaces"
                  >
                    <div className="category-header-main">
                      <span className="sidebar-item-icon" style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                          <rect x="3" y="3" width="7" height="7" rx="1.5" />
                          <rect x="14" y="3" width="7" height="7" rx="1.5" />
                          <rect x="14" y="14" width="7" height="7" rx="1.5" />
                          <rect x="3" y="14" width="7" height="7" rx="1.5" />
                        </svg>
                      </span>
                      <span className="category-header-title">Workspaces</span>
                    </div>
                    <span className="category-chevron">{activeCategory === 'workspace' ? '▾' : '▸'}</span>
                  </button>

                  {activeCategory === 'workspace' && (
                    <div className="sidebar-sub-items">
                      {/* 1. Dual Whiteboard */}
                      <button
                        type="button"
                        className={`sidebar-nav-item ${workspaceView === 'whiteboard' ? 'active' : ''}`}
                        onClick={() => handleSetWorkspaceView('whiteboard')}
                        title="Dual Whiteboard (Typing + Canvas)"
                      >
                        <span className="sidebar-item-icon">✏️</span>
                        <div className="sidebar-item-label">
                          <span className="sidebar-item-title">Dual Whiteboard</span>
                          <span className="sidebar-item-sub">Typing & Canvas Studio</span>
                        </div>
                        <span className="sidebar-item-badge blue">Board</span>
                      </button>

                      {/* 2. YouTube & Video Sync */}
                      <button
                        type="button"
                        className={`sidebar-nav-item ${workspaceView === 'video' ? 'active' : ''}`}
                        onClick={() => handleSetWorkspaceView('video')}
                        title="Lecture Video & YouTube Sync"
                      >
                        <span className="sidebar-item-icon">🎬</span>
                        <div className="sidebar-item-label">
                          <span className="sidebar-item-title">YouTube & Video</span>
                          <span className="sidebar-item-sub">Synced Watch Party</span>
                        </div>
                        <span className="sidebar-item-badge red">Video</span>
                      </button>

                      {/* 3. All-In-One Unified View */}
                      <button
                        type="button"
                        className={`sidebar-nav-item ${workspaceView === 'all' ? 'active' : ''}`}
                        onClick={() => handleSetWorkspaceView('all')}
                        title="All-In-One Unified View"
                      >
                        <span className="sidebar-item-icon">🔲</span>
                        <div className="sidebar-item-label">
                          <span className="sidebar-item-title">All-In-One View</span>
                          <span className="sidebar-item-sub">Split Screen Layout</span>
                        </div>
                        <span className="sidebar-item-badge purple">Unified</span>
                      </button>

                      {/* 4. Camera Grid View */}
                      <button
                        type="button"
                        className={`sidebar-nav-item ${workspaceView === 'cameras' ? 'active' : ''}`}
                        onClick={() => handleSetWorkspaceView('cameras')}
                        title="Camera Video Call Grid"
                      >
                        <span className="sidebar-item-icon">📹</span>
                        <div className="sidebar-item-label">
                          <span className="sidebar-item-title">Camera Grid</span>
                          <span className="sidebar-item-sub">Webcams & Gallery</span>
                        </div>
                        <span className={`sidebar-status-dot ${videoOn ? 'live' : 'off'}`} />
                      </button>
                    </div>
                  )}
                </div>

                {/* 2. Tools & Apps Category */}
                <div className="sidebar-category-group">
                  <button
                    type="button"
                    className={`sidebar-category-header ${activeCategory === 'tools' ? 'category-active' : ''}`}
                    onClick={() => setActiveCategory(prev => prev === 'tools' ? null : 'tools')}
                    title="Click to expand/collapse Tools & Apps"
                  >
                    <div className="category-header-main">
                      <span className="sidebar-item-icon">🛠️</span>
                      <span className="category-header-title">Tools & Apps</span>
                    </div>
                    <span className="category-chevron">{activeCategory === 'tools' ? '▾' : '▸'}</span>
                  </button>

                  {activeCategory === 'tools' && (
                    <div className="sidebar-sub-items">
                      {/* ✨ Coursera-style Gemini Class Coach */}
                      <button
                        type="button"
                        className={`sidebar-nav-item ${activeTab === 'ai' ? 'active' : ''}`}
                        onClick={() => setActiveTab(prev => prev === 'ai' ? null : 'ai')}
                        title={`✨ Gemini Class Coach: Topic "${currentLectureTopic}"`}
                      >
                        <span className="sidebar-item-icon">✨</span>
                        <div className="sidebar-item-label">
                          <span className="sidebar-item-title">Gemini Class Coach</span>
                          <span className="sidebar-item-sub">Topic: {currentLectureTopic}</span>
                        </div>
                        <span className="sidebar-item-badge amber">GEMINI</span>
                      </button>

                      {/* Live Lecture Notes */}
                      <button
                        type="button"
                        className={`sidebar-nav-item ${activeTab === 'notes' ? 'active' : ''}`}
                        onClick={() => setActiveTab(prev => prev === 'notes' ? null : 'notes')}
                        title="Live Lecture Transcribed Notes"
                      >
                        <span className="sidebar-item-icon">🎙️</span>
                        <div className="sidebar-item-label">
                          <span className="sidebar-item-title">Lecture Notes</span>
                          <span className="sidebar-item-sub">{transcription.length > 0 ? `${transcription.length} notes captured` : 'Auto-transcription'}</span>
                        </div>
                      </button>

                      {/* Record Session */}
                      <button
                        type="button"
                        className={`sidebar-nav-item ${isRecordingSession ? 'recording' : ''}`}
                        onClick={toggleSessionRecording}
                        title={isRecordingSession ? "Stop Recording" : "Record Session & Download"}
                      >
                        <span className="sidebar-item-icon">{isRecordingSession ? '⏹️' : '⏺️'}</span>
                        <div className="sidebar-item-label">
                          <span className="sidebar-item-title">{isRecordingSession ? 'Recording...' : 'Record Lecture'}</span>
                          <span className="sidebar-item-sub">Save to PC / Library</span>
                        </div>
                      </button>


                      {/* Raise Hand (For Students) */}
                      {!isInstructor && (
                        <button
                          type="button"
                          className={`sidebar-nav-item ${hasHandRaised ? 'active' : ''}`}
                          onClick={toggleRaiseHand}
                          title={hasHandRaised ? "Lower Hand" : "Raise Hand"}
                        >
                          <span className="sidebar-item-icon">✋</span>
                          <div className="sidebar-item-label">
                            <span className="sidebar-item-title">{hasHandRaised ? 'Hand Raised' : 'Raise Hand'}</span>
                            <span className="sidebar-item-sub">Notify Teacher</span>
                          </div>
                        </button>
                      )}
                    </div>
                  )}
                </div>

                {/* 3. Host Management (Instructor only) */}
                {isInstructor && (
                  <div className="sidebar-category-group">
                    <button
                      type="button"
                      className={`sidebar-category-header ${activeCategory === 'host' ? 'category-active' : ''}`}
                      onClick={() => setActiveCategory(prev => prev === 'host' ? null : 'host')}
                      title="Click to expand/collapse Host Controls"
                    >
                      <div className="category-header-main">
                        <span className="sidebar-item-icon">👑</span>
                        <span className="category-header-title">Host Controls</span>
                      </div>
                      <span className="category-chevron">{activeCategory === 'host' ? '▾' : '▸'}</span>
                    </button>

                    {activeCategory === 'host' && (
                      <div className="sidebar-sub-items">
                        {/* Host Controls */}
                        <button
                          type="button"
                          className={`sidebar-nav-item ${activeTab === 'host' ? 'active' : ''}`}
                          onClick={() => setActiveTab(prev => prev === 'host' ? null : 'host')}
                          title="Open Instructor Host Controls & Roster"
                        >
                          <span className="sidebar-item-icon">⚙️</span>
                          <div className="sidebar-item-label">
                            <span className="sidebar-item-title">Host Controls</span>
                            <span className="sidebar-item-sub">Mute All & Student Cams</span>
                          </div>
                        </button>

                        {/* Lock Room */}
                        <button
                          type="button"
                          className={`sidebar-nav-item ${isRoomLocked ? 'locked' : ''}`}
                          onClick={handleToggleRoomLock}
                          title={isRoomLocked ? "Unlock Classroom" : "Lock Classroom"}
                        >
                          <span className="sidebar-item-icon">{isRoomLocked ? '🔒' : '🔓'}</span>
                          <div className="sidebar-item-label">
                            <span className="sidebar-item-title">{isRoomLocked ? 'Room Locked' : 'Lock Room'}</span>
                            <span className="sidebar-item-sub">{isRoomLocked ? 'No new joins' : 'Open for joins'}</span>
                          </div>
                        </button>

                        {/* Copy Invite Link */}
                        <button
                          type="button"
                          className="sidebar-nav-item"
                          onClick={copyInviteLink}
                          title="Copy Direct Shareable Invite Link"
                        >
                          <span className="sidebar-item-icon">🔗</span>
                          <div className="sidebar-item-label">
                            <span className="sidebar-item-title">Copy Invite Link</span>
                            <span className="sidebar-item-sub">Direct join URL</span>
                          </div>
                        </button>

                        {/* WhatsApp & Email Full Invite */}
                        <button
                          type="button"
                          className="sidebar-nav-item"
                          onClick={copyClassInvitation}
                          title="Copy complete formatted class invitation"
                        >
                          <span className="sidebar-item-icon">📋</span>
                          <div className="sidebar-item-label">
                            <span className="sidebar-item-title">Class Invite</span>
                            <span className="sidebar-item-sub">WhatsApp & Email text</span>
                          </div>
                        </button>
                      </div>
                    )}
                  </div>
                )}

                {/* 4. General Settings */}
                <div className="sidebar-category-group">
                  <button
                    type="button"
                    className="sidebar-category-header"
                    onClick={() => onOpenSettings && onOpenSettings('general')}
                    title="Classroom & Device Settings"
                  >
                    <div className="category-header-main">
                      <span className="sidebar-item-icon">⚙️</span>
                      <span className="category-header-title">Settings</span>
                    </div>
                    <span style={{ fontSize: '0.8rem', color: '#94a3b8' }}>↗</span>
                  </button>
                </div>
              </div>
            )}
          </div>
        </aside>

        <div className="workspace-area">

          {/* Synchronized Video Player & YouTube Collaboration */}
          {(workspaceView === 'video' || workspaceView === 'all') && (
            <div className="video-player-section">
              <VideoPlayer
                roomId={cleanRoomId(roomId)}
                isInstructor={isInstructor}
                user={user}
                theme={theme}
                pinnedDoubts={pinnedDoubts}
                onPinDoubt={handleAddPinnedDoubt}
                onResolveDoubt={handleResolveDoubt}
              />
            </div>
          )}

          {/* Live Camera Grid */}
          <div className={`video-grid ${workspaceView === 'cameras' ? 'large-grid' : workspaceView === 'whiteboard' ? 'compact-grid' : ''}`}>
            <LocalVideo
              stream={userStream}
              videoOn={videoOn}
              isSpeaking={localMicVolume > 15 && micOn}
              micOn={micOn}
              isBackgroundBlurred={isBackgroundBlurred}
              isAutoFramed={isAutoFramed}
              user={user}
              onOpenSettings={onOpenSettings}
              isHandRaised={hasHandRaised}
            />
            {peers.map(peerObj => {
              const pInfo = participants.find(p => p.socketId === peerObj.peerID) || {
                socketId: peerObj.peerID,
                userName: 'Peer',
                userRole: 'student'
              };
              const mState = peerMediaStates[peerObj.peerID];
              const isPeerHandRaised = Boolean(
                handRaisedUsers[peerObj.peerID] || 
                handRaisedUsers[pInfo.socketId] || 
                handRaisedUsers[pInfo.userId] || 
                (pInfo.userName && handRaisedUsers[pInfo.userName])
              );
              return (
                <div className={`video-card ${isPeerHandRaised ? 'hand-raised-card' : ''}`} key={peerObj.peerID}>
                  <RemoteVideo peer={peerObj.peer} peerInfo={pInfo} mediaState={mState} isHandRaised={isPeerHandRaised} />
                </div>
              );
            })}
          </div>

          {/* Whiteboard */}
          {(workspaceView === 'whiteboard' || workspaceView === 'all') && (
            <div className={`canvas-area ${workspaceView === 'whiteboard' ? 'full-view' : ''}`}>
              <WhiteboardCanvas roomId={roomId} user={user} theme={theme} />
            </div>
          )}
        </div>

        {/* ── Sidebar (On-Demand, opens when bottom chat icon is clicked) ── */}
        {activeTab && (
          <aside className={`sidebar-panel ${panelSizeMode}`}>
            <div className="panel-header-custom">
              <div className="panel-header-top">
                <div className="panel-header-title-box">
                  <span className="panel-main-icon">
                    {activeTab === 'chat' && '💬'}
                    {activeTab === 'ai' && '✨'}
                    {activeTab === 'notes' && '🎙️'}
                    {activeTab === 'host' && '👥'}
                  </span>
                  <div className="panel-title-text-group">
                    <span className="panel-main-title">
                      {activeTab === 'chat' && 'Classroom Discussion'}
                      {activeTab === 'ai' && '✨ Gemini Class Coach'}
                      {activeTab === 'notes' && 'Live Lecture Notes'}
                      {activeTab === 'host' && 'Classroom Participants'}
                    </span>
                    <span className="panel-sub-title">
                      {activeTab === 'chat' && 'Live Doubts & Peer Q&A'}
                      {activeTab === 'ai' && `Topic: ${currentLectureTopic}`}
                      {activeTab === 'notes' && `${transcription.length} Captured Transcripts`}
                      {activeTab === 'host' && `${participants.length || 1} Connected Members`}
                    </span>
                  </div>
                </div>

                {/* Window Controls: Maximize, Close */}
                <div className="panel-window-controls">
                  <button
                    type="button"
                    className={`panel-win-btn ${panelSizeMode === 'maximized' ? 'active' : ''}`}
                    onClick={() => setPanelSizeMode(prev => prev === 'maximized' ? 'normal' : 'maximized')}
                    title={panelSizeMode === 'maximized' ? "Restore Normal Size" : "Maximize Panel"}
                    aria-label="Toggle panel size"
                  >
                    {panelSizeMode === 'maximized' ? (
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                        <polyline points="4 14 10 14 10 20"></polyline>
                        <polyline points="20 10 14 10 14 4"></polyline>
                        <line x1="14" y1="10" x2="21" y2="3"></line>
                        <line x1="3" y1="21" x2="10" y2="14"></line>
                      </svg>
                    ) : (
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                        <polyline points="15 3 21 3 21 9"></polyline>
                        <polyline points="9 21 3 21 3 15"></polyline>
                        <line x1="21" y1="3" x2="14" y2="10"></line>
                        <line x1="3" y1="21" x2="10" y2="14"></line>
                      </svg>
                    )}
                  </button>
                  <button
                    type="button"
                    className="panel-win-btn panel-close-btn"
                    onClick={() => {
                      setActiveTab(null);
                      setPanelSizeMode('normal');
                    }}
                    title="Close Panel (✕)"
                  >
                    ✕
                  </button>
                </div>
              </div>
            </div>

            <div className="panel-content">
              {/* Tab 1: Live Chat & Pinned Doubts */}
              {activeTab === 'chat' && (
                <div className="chat-container">
                  {/* Chat Top Bar */}
                  <div className="chat-header-bar">
                    <span>💬 Classroom Discussion</span>
                    <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                      {isInstructor && (
                        <button
                          type="button"
                          className={`chat-lock-toggle-btn ${isChatLocked ? 'locked' : ''}`}
                          onClick={handleToggleChatLock}
                          title={isChatLocked ? "Unlock student chat" : "Lock student chat"}
                        >
                          {isChatLocked ? '🔒 Chat Locked' : '🔓 Lock Chat'}
                        </button>
                      )}
                      <button
                        type="button"
                        className="chat-export-btn"
                        onClick={downloadChatHistory}
                        title="Export chat history to a text file"
                      >
                        📥 Export Chat
                      </button>
                    </div>
                  </div>

                  {/* Chat Lock Notification Banner */}
                  {isChatLocked && (
                    <div className={`chat-lock-status-banner ${isInstructor ? 'instructor-mode' : 'student-mode'}`}>
                      {isInstructor ? (
                        <span>🔒 <strong>Student chat is locked.</strong> Your messages and announcements will still be delivered.</span>
                      ) : (
                        <span>🔒 <strong>Chat has been locked by the teacher.</strong> Student messaging is paused right now.</span>
                      )}
                    </div>
                  )}

                  {/* Pinned Doubts Accordion */}
                  {pinnedDoubts.length > 0 && (
                    <div className="pinned-doubts-card">
                      <div
                        className="pinned-doubts-header"
                        onClick={() => setShowPinnedDoubts(!showPinnedDoubts)}
                        title="Click to toggle pinned doubts"
                      >
                        <span>📌 Pinned Doubts ({pinnedDoubts.length})</span>
                        <span style={{ fontSize: '0.7rem' }}>{showPinnedDoubts ? '▲ Hide' : '▼ View'}</span>
                      </div>

                      {showPinnedDoubts && (
                        <div className="pinned-doubts-list">
                          {pinnedDoubts.map(d => (
                            <div key={d.id} className="pinned-doubt-item">
                              <div className="pinned-doubt-info">
                                <span className="pinned-doubt-sender">
                                  ❓ {d.senderName} · {d.time}
                                  {typeof d.videoTimestamp === 'number' && (
                                    <span style={{
                                      marginLeft: 6,
                                      background: 'rgba(245, 158, 11, 0.2)',
                                      color: '#f59e0b',
                                      border: '1px solid rgba(245, 158, 11, 0.4)',
                                      padding: '1px 6px',
                                      borderRadius: 4,
                                      fontSize: '0.72rem',
                                      fontWeight: 700
                                    }}>
                                      🎬 {d.videoTimeFormatted || `${Math.floor(d.videoTimestamp)}s`}
                                    </span>
                                  )}
                                </span>
                                <div className="pinned-doubt-text">{d.text}</div>
                              </div>
                              <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                                {typeof d.videoTimestamp === 'number' && (
                                  <button
                                    type="button"
                                    onClick={() => handleJumpToVideoMoment(d.videoTimestamp, d.videoTimeFormatted)}
                                    style={{
                                      background: 'rgba(245, 158, 11, 0.15)',
                                      border: '1px solid rgba(245, 158, 11, 0.5)',
                                      color: '#fbbf24',
                                      borderRadius: 6,
                                      padding: '4px 8px',
                                      fontSize: '0.72rem',
                                      cursor: 'pointer',
                                      fontWeight: 700
                                    }}
                                    title="Jump to video moment"
                                  >
                                    ▶ Jump
                                  </button>
                                )}
                                <button
                                  type="button"
                                  className="btn-unpin-doubt"
                                  onClick={() => handleResolveDoubt(d.id)}
                                  title="Mark doubt as resolved"
                                >
                                  ✅
                                </button>
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}

                  {/* Messages Feed */}
                  <div className="chat-messages">
                    {messages.length === 0 ? (
                      <div className="chat-empty-state">
                        <span className="empty-icon">💬</span>
                        <p className="empty-title">No messages yet.</p>
                        <p className="empty-sub">Ask questions, pin lecture doubts, or share notes with peers!</p>
                      </div>
                    ) : (
                      messages.map((msg) => {
                        const isMe = msg.senderId === socket.id;
                        const isMsgInstructor = msg.senderRole === 'instructor';
                        return (
                          <div key={msg.id} className={`chat-message-group ${isMe ? 'mine' : 'theirs'}`}>
                            <span className="chat-sender-name">
                              {msg.senderName}
                              <span className={`chat-role-badge ${isMsgInstructor ? 'instructor' : 'student'}`}>
                                {isMsgInstructor ? '👨‍🏫 Instructor' : '🎓 Student'}
                              </span>
                              · {msg.time}
                              {/* Pin Doubt Button */}
                              <button
                                type="button"
                                className="btn-pin-message"
                                onClick={() => handlePinDoubt(msg)}
                                title="Pin this message as a Doubt for instructor"
                              >
                                📌
                              </button>
                            </span>

                            <div className={`chat-bubble ${isMe ? 'mine' : 'theirs'} ${msg.isDoubt ? 'doubt-bubble' : ''}`}>
                              {/* Doubt Chip */}
                              {msg.isDoubt && (
                                <div className="doubt-tag-chip">
                                  <span>❓ DOUBT QUESTION</span>
                                  {typeof msg.videoTimestamp === 'number' && (
                                    <span style={{ marginLeft: 6, background: 'rgba(245, 158, 11, 0.3)', padding: '1px 5px', borderRadius: 4, fontSize: '0.68rem', fontWeight: 800 }}>
                                      🎬 {msg.videoTimeFormatted || `${Math.floor(msg.videoTimestamp)}s`}
                                    </span>
                                  )}
                                </div>
                              )}

                              {/* Text message */}
                              {msg.message && <div style={msg.isDoubt ? { fontWeight: 600, marginTop: 4 } : {}}>{msg.message}</div>}

                              {/* Doubt Interactive Action Bar (Jump to Video & Resolve) */}
                              {msg.isDoubt && (
                                <div style={{ marginTop: 8, display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                                  {typeof msg.videoTimestamp === 'number' && (
                                    <button
                                      type="button"
                                      onClick={() => handleJumpToVideoMoment(msg.videoTimestamp, msg.videoTimeFormatted)}
                                      style={{
                                        background: 'rgba(245, 158, 11, 0.25)',
                                        border: '1px solid rgba(245, 158, 11, 0.6)',
                                        color: '#fbbf24',
                                        padding: '4px 10px',
                                        borderRadius: 6,
                                        fontSize: '0.72rem',
                                        cursor: 'pointer',
                                        fontWeight: 700,
                                        display: 'inline-flex',
                                        alignItems: 'center',
                                        gap: 4
                                      }}
                                      title="Jump video to this doubt timestamp"
                                    >
                                      ▶ Jump to Video ({msg.videoTimeFormatted || `${Math.floor(msg.videoTimestamp)}s`})
                                    </button>
                                  )}

                                  {isInstructor && (
                                    <button
                                      type="button"
                                      onClick={() => handleResolveDoubt(msg.doubtId || msg.id)}
                                      style={{
                                        background: 'rgba(34, 197, 94, 0.25)',
                                        border: '1px solid rgba(34, 197, 94, 0.6)',
                                        color: '#4ade80',
                                        padding: '4px 10px',
                                        borderRadius: 6,
                                        fontSize: '0.72rem',
                                        cursor: 'pointer',
                                        fontWeight: 700,
                                        display: 'inline-flex',
                                        alignItems: 'center',
                                        gap: 4
                                      }}
                                      title="Mark doubt as resolved"
                                    >
                                      ✅ Resolve Doubt
                                    </button>
                                  )}
                                </div>
                              )}

                              {/* Attached File Preview */}
                              {msg.file && (
                                <div className="chat-file-attachment">
                                  {msg.file.isImage ? (
                                    <a href={msg.file.dataUrl} target="_blank" rel="noreferrer" title="Click to view full image">
                                      <img src={msg.file.dataUrl} alt={msg.file.name} className="chat-image-preview" />
                                    </a>
                                  ) : (
                                    <a href={msg.file.dataUrl} download={msg.file.name} className="chat-file-card">
                                      <span>📎</span>
                                      <div>
                                        <div style={{ fontWeight: 600 }}>{msg.file.name}</div>
                                        <div style={{ fontSize: '0.68rem', opacity: 0.8 }}>{msg.file.size} • Download</div>
                                      </div>
                                    </a>
                                  )}
                                </div>
                              )}
                            </div>
                          </div>
                        );
                      })
                    )}
                    <div ref={chatEndRef} />
                  </div>

                  {/* Form & Input Controls */}
                  <form onSubmit={sendMessage} className="chat-form">
                    {/* File Upload Preview Bar */}
                    {selectedFile && (
                      <div className="file-upload-preview-bar">
                        <span>
                          {selectedFile.isImage ? '🖼️' : '📄'} {selectedFile.name} ({selectedFile.size})
                        </span>
                        <button type="button" onClick={() => setSelectedFile(null)} title="Remove attachment">
                          ✕
                        </button>
                      </div>
                    )}

                    {/* Hidden file input */}
                    <input
                      type="file"
                      ref={fileInputRef}
                      onChange={handleFileSelect}
                      style={{ display: 'none' }}
                      accept="image/*,.pdf,.doc,.docx,.txt,.zip"
                      disabled={!isInstructor && isChatLocked}
                    />

                    <div className="chat-input-row">
                      {/* Paperclip file attach button */}
                      <button
                        type="button"
                        className="chat-icon-btn"
                        onClick={() => fileInputRef.current?.click()}
                        title={!isInstructor && isChatLocked ? "Chat is locked by teacher" : "Attach Image or Document (under 3MB)"}
                        disabled={!isInstructor && isChatLocked}
                      >
                        📎
                      </button>

                      {/* Doubt toggle button */}
                      <button
                        type="button"
                        className={`chat-doubt-toggle ${isDoubtMode ? 'active' : ''}`}
                        onClick={() => setIsDoubtMode(!isDoubtMode)}
                        title={!isInstructor && isChatLocked ? "Chat is locked by teacher" : isDoubtMode ? "Marked as Doubt (will be highlighted & pinned)" : "Click to mark next message as Doubt"}
                        disabled={!isInstructor && isChatLocked}
                      >
                        <span>❓</span>
                        <span className="doubt-label-text">Doubt</span>
                      </button>

                      {/* Input field with corner send icon */}
                      <div className="chat-input-wrapper">
                        <input
                          type="text"
                          placeholder={
                            !isInstructor && isChatLocked
                              ? "🔒 Chat has been locked by the teacher..."
                              : isDoubtMode
                              ? "Type your doubt question..."
                              : "Type a message..."
                          }
                          value={newMessage}
                          onChange={(e) => setNewMessage(e.target.value)}
                          className={isDoubtMode ? "input-doubt-active" : (!isInstructor && isChatLocked ? "input-chat-locked" : "")}
                          disabled={!isInstructor && isChatLocked}
                        />
                        <button
                          type="submit"
                          className="chat-send-icon-btn"
                          disabled={(!isInstructor && isChatLocked) || (!newMessage.trim() && !selectedFile)}
                          title={!isInstructor && isChatLocked ? "Chat is locked by teacher" : "Send message"}
                        >
                          <Send size={15} />
                        </button>
                      </div>
                    </div>
                  </form>
                </div>
              )}

              {/* Tab 2: Live Transcripts & Notes */}
              {activeTab === 'notes' && (
                <div className="notes-container">
                  <div className="notes-header-bar">
                    <div className="notes-title-group">
                      <span className="notes-header-title">🎙️ Live Notes</span>
                      {isTranscribing ? (
                        <span className="badge-pulse-recording">● Recording Voice</span>
                      ) : (
                        <span className="badge-pulse-idle">○ Voice Paused</span>
                      )}
                    </div>
                    <div className="notes-header-actions">
                      <button
                        type="button"
                        className={`notes-record-toggle-btn ${isTranscribing ? 'recording' : ''}`}
                        onClick={handleToggleSpeechRecognition}
                        title={isTranscribing ? "Pause voice transcription" : "Start transcribing microphone speech live"}
                      >
                        {isTranscribing ? '⏹️ Stop Mic' : '🎙️ Start Mic'}
                      </button>
                      <button
                        type="button"
                        className="notes-export-btn notes-txt-btn"
                        onClick={downloadNotesTXT}
                        title="Download notes as TXT file"
                        disabled={transcription.length === 0}
                      >
                        📝 TXT
                      </button>
                      <button
                        type="button"
                        className="notes-export-btn notes-pdf-btn"
                        onClick={downloadNotesPDF}
                        title="Export verified lecture PDF notes"
                        disabled={transcription.length === 0}
                      >
                        📄 PDF
                      </button>
                    </div>
                  </div>

                  {/* Quick Note Manual Entry */}
                  <form className="notes-manual-input-bar" onSubmit={handleAddManualNote}>
                    <input
                      type="text"
                      className="notes-input-field"
                      placeholder="Type a key lecture note or highlight..."
                      value={manualNoteInput}
                      onChange={(e) => setManualNoteInput(e.target.value)}
                    />
                    <button
                      type="submit"
                      className="notes-add-btn"
                      disabled={!manualNoteInput.trim()}
                      title="Add note to live notes board"
                    >
                      + Add
                    </button>
                  </form>

                  <div className="notes-feed">
                    {transcription.length === 0 ? (
                      <div className="notes-empty-state">
                        <span className="empty-icon">🎙️</span>
                        <p className="empty-title">Waiting for lecture notes...</p>
                        <p className="empty-sub">
                          Click <strong>"🎙️ Start Mic"</strong> to transcribe spoken lecture audio automatically in real time, or type bullet points in the input box above!
                        </p>
                        <button
                          type="button"
                          className="notes-start-quick-btn"
                          onClick={handleToggleSpeechRecognition}
                        >
                          🎙️ Start Speech Transcription
                        </button>
                      </div>
                    ) : (
                      <>
                        {transcription.map((item) => (
                          <div key={item.id} className="note-card">
                            <div className="note-meta">
                              <span className="note-speaker-badge">
                                {item.speaker?.includes('Instructor') ? '👨‍🏫' : '👤'} {item.speaker}
                              </span>
                              <div className="note-meta-right">
                                <span className="note-time-badge">{item.time}</span>
                                <button
                                  type="button"
                                  className="note-copy-btn"
                                  onClick={() => {
                                    navigator.clipboard.writeText(item.text);
                                    showToast('📋 Copied note to clipboard!', 'info');
                                  }}
                                  title="Copy note"
                                >
                                  Copy
                                </button>
                              </div>
                            </div>
                            <p className="note-text">{item.text}</p>
                          </div>
                        ))}
                        <div className="notes-footer-summary">
                          <span>{transcription.length} note{transcription.length > 1 ? 's' : ''} captured</span>
                          <div className="notes-footer-btns">
                            <button type="button" onClick={downloadNotesTXT}>Export TXT</button>
                            <button type="button" onClick={downloadNotesPDF}>Export PDF</button>
                          </div>
                        </div>
                      </>
                    )}
                  </div>
                </div>
              )}

              {/* Tab: ✨ Coursera-Style Gemini Class Coach Assistant */}
              {activeTab === 'ai' && (
                <div className="ai-tutor-container gemini-coach-container">
                  {/* Slim Topic Bar (Minimal, frees up maximum space for chat) */}
                  <div className="gemini-slim-topic-bar">
                    <div className="gemini-slim-topic-left">
                      <span className="gemini-slim-topic-pin">📌 Topic:</span>
                      <span className="gemini-slim-topic-text" title={currentLectureTopic}>
                        {currentLectureTopic}
                      </span>
                    </div>
                    <button
                      type="button"
                      className="gemini-slim-popup-trigger"
                      onClick={() => setShowPromptSuggestions(true)}
                      title="Open suggested topic questions popup"
                    >
                      💡 Suggestions
                    </button>
                  </div>

                  {/* AI Chat History with Full Spacious View */}
                  <div className="ai-tutor-messages gemini-messages-list">
                    {aiChatMessages.map((msg) => (
                      <div key={msg.id} className={`ai-chat-bubble gemini-bubble ${msg.sender}`}>
                        <div className="ai-bubble-sender gemini-bubble-meta">
                          <div className="gemini-bubble-meta-left">
                            <span className="gemini-sender-name">
                              {msg.sender === 'assistant' ? '✨ Gemini Coach' : '👤 You'}
                            </span>
                          </div>
                          <div className="gemini-bubble-meta-right">
                            <span className="gemini-time-tag">{msg.time}</span>
                            {msg.sender === 'assistant' && (
                              <button
                                type="button"
                                className="gemini-copy-bubble-btn"
                                onClick={() => {
                                  navigator.clipboard.writeText(msg.text);
                                  showToast('📋 Copied explanation to clipboard!', 'info');
                                }}
                                title="Copy answer"
                              >
                                Copy
                              </button>
                            )}
                          </div>
                        </div>
                        <div className="gemini-bubble-body">
                          {renderFormattedAiText(msg.text)}
                        </div>
                      </div>
                    ))}
                    {isAiThinking && (
                      <div className="ai-chat-bubble assistant gemini-thinking-bubble">
                        <div className="ai-bubble-sender gemini-bubble-meta">
                          <div className="gemini-bubble-meta-left">
                            <span className="gemini-sender-name">✨ Gemini Coach</span>
                            <span className="gemini-source-tag pulsing">Thinking...</span>
                          </div>
                        </div>
                        <div className="gemini-thinking-text">
                          <span className="gemini-loader-dot" /> Analyzing <strong>"{currentLectureTopic}"</strong> & crafting response...
                        </div>
                      </div>
                    )}
                    <div ref={aiChatEndRef} />
                  </div>

                  {/* AI Input Box with Popup Trigger */}
                  <div className="ai-tutor-input-box gemini-input-container">
                    <button
                      type="button"
                      className="gemini-input-popup-btn"
                      onClick={() => setShowPromptSuggestions(prev => !prev)}
                      title="Open suggested topic questions"
                    >
                      💡
                    </button>
                    <input
                      type="text"
                      className="ai-tutor-input gemini-input-field"
                      placeholder={`Ask Gemini about "${currentLectureTopic}"...`}
                      value={aiPromptInput}
                      onChange={(e) => setAiPromptInput(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') handleSendAiPrompt();
                      }}
                    />
                    <button
                      type="button"
                      className="ai-tutor-send-btn gemini-ask-btn"
                      onClick={() => handleSendAiPrompt()}
                      disabled={!aiPromptInput.trim() || isAiThinking}
                      title="Ask Gemini Coach"
                    >
                      <span>✨ Ask</span>
                    </button>
                  </div>

                  {/* ✨ Image 2 as a Popup / Modal Dialog */}
                  {showPromptSuggestions && (
                    <div
                      className="gemini-popup-overlay"
                      onClick={() => setShowPromptSuggestions(false)}
                    >
                      <div
                        className="gemini-popup-card"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <div className="gemini-popup-header">
                          <div className="gemini-popup-title-group">
                            <span className="gemini-popup-sparkle">💡</span>
                            <div className="gemini-popup-headings">
                              <span className="gemini-popup-main-title">Suggested Questions</span>
                              <span className="gemini-popup-sub-title">Topic: {currentLectureTopic}</span>
                            </div>
                          </div>
                          <button
                            type="button"
                            className="gemini-popup-close-btn"
                            onClick={() => setShowPromptSuggestions(false)}
                            title="Close"
                          >
                            ✕
                          </button>
                        </div>

                        <div className="gemini-popup-body">
                          <div className="gemini-popup-chips-stack">
                            <button
                              type="button"
                              className="gemini-popup-chip-item"
                              onClick={() => {
                                setShowPromptSuggestions(false);
                                handleSendAiPrompt(`Explain the core concept and definition of ${currentLectureTopic}`);
                              }}
                            >
                              <span className="gemini-popup-chip-icon">💡</span>
                              <span className="gemini-popup-chip-text">Concept: What is {currentLectureTopic}?</span>
                            </button>

                            <button
                              type="button"
                              className="gemini-popup-chip-item"
                              onClick={() => {
                                setShowPromptSuggestions(false);
                                handleSendAiPrompt(`Give a real-world analogy and industry example for ${currentLectureTopic}`);
                              }}
                            >
                              <span className="gemini-popup-chip-icon">🎯</span>
                              <span className="gemini-popup-chip-text">Analogy & Example</span>
                            </button>

                            <button
                              type="button"
                              className="gemini-popup-chip-item"
                              onClick={() => {
                                setShowPromptSuggestions(false);
                                handleSendAiPrompt(`Show a complete, practical code implementation for ${currentLectureTopic}`);
                              }}
                            >
                              <span className="gemini-popup-chip-icon">💻</span>
                              <span className="gemini-popup-chip-text">Code & Architecture</span>
                            </button>

                            <button
                              type="button"
                              className="gemini-popup-chip-item"
                              onClick={() => {
                                setShowPromptSuggestions(false);
                                handleSendAiPrompt(`What are top 5 exam and interview viva questions on ${currentLectureTopic}?`);
                              }}
                            >
                              <span className="gemini-popup-chip-icon">📝</span>
                              <span className="gemini-popup-chip-text">Top Exam Questions</span>
                            </button>

                            <button
                              type="button"
                              className="gemini-popup-chip-item"
                              onClick={() => {
                                setShowPromptSuggestions(false);
                                handleSendAiPrompt("Summarize the current lecture session and main takeaways");
                              }}
                            >
                              <span className="gemini-popup-chip-icon">⚡</span>
                              <span className="gemini-popup-chip-text">Recap Lecture</span>
                            </button>
                          </div>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* Tab 3: Host Controls & Participants List */}
              {activeTab === 'host' && (
                <div className="host-panel-content">
                  {/* Instructor Action Controls */}
                  {isInstructor && (
                    <>
                      <div className="host-section-title">
                        👨‍🏫 Host Management
                      </div>
                      <div className="host-actions-grid">
                        <button
                          type="button"
                          className={`host-action-btn ${isMuteAllActive ? 'btn-muted' : 'btn-mute-all'}`}
                          onClick={handleHostMuteAll}
                          title={isMuteAllActive ? "All participants are muted (Click to unmute)" : "Mute all students in this session"}
                        >
                          <span>🔇</span>
                          <span>{isMuteAllActive ? 'Muted' : 'Mute All'}</span>
                        </button>

                        <button
                          type="button"
                          className={`host-action-btn ${isRoomLocked ? 'btn-unlock' : 'btn-lock'}`}
                          onClick={handleToggleRoomLock}
                          title={isRoomLocked ? "Unlock room to allow new students to enter" : "Lock room to prevent new entries"}
                        >
                          <span>{isRoomLocked ? '🔓' : '🔒'}</span>
                          <span>{isRoomLocked ? 'Unlock Room' : 'Lock Room'}</span>
                        </button>
                      </div>

                      {/* Waiting Room Roster for Instructor */}
                      {pendingAdmissionRequests.length > 0 && (
                        <div style={{ marginBottom: '1.2rem', background: 'rgba(6, 182, 212, 0.08)', border: '1.5px solid rgba(6, 182, 212, 0.4)', borderRadius: '10px', padding: '12px' }}>
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
                            <span style={{ fontSize: '0.85rem', fontWeight: 800, color: '#38bdf8', display: 'flex', alignItems: 'center', gap: '6px' }}>
                              <span>⏳ Waiting Room</span>
                              <span style={{ background: '#0284c7', color: '#fff', borderRadius: '99px', padding: '1px 7px', fontSize: '0.72rem' }}>
                                {pendingAdmissionRequests.length}
                              </span>
                            </span>
                            {pendingAdmissionRequests.length > 1 && (
                              <button
                                type="button"
                                onClick={handleAdmitAllStudents}
                                style={{ background: '#10b981', color: '#fff', border: 'none', borderRadius: '4px', padding: '3px 8px', fontSize: '0.74rem', fontWeight: 700, cursor: 'pointer' }}
                              >
                                Admit All
                              </button>
                            )}
                          </div>
                          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                            {pendingAdmissionRequests.map(student => (
                              <div key={student.socketId} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: 'rgba(15, 23, 42, 0.6)', padding: '6px 10px', borderRadius: '6px' }}>
                                <span style={{ fontSize: '0.82rem', fontWeight: 600, color: '#f8fafc' }}>
                                  👤 {student.userName}
                                </span>
                                <div style={{ display: 'flex', gap: '6px' }}>
                                  <button
                                    type="button"
                                    onClick={() => handleAdmitStudent(student.socketId)}
                                    style={{ background: '#10b981', color: '#fff', border: 'none', borderRadius: '4px', padding: '3px 8px', fontSize: '0.74rem', fontWeight: 700, cursor: 'pointer' }}
                                  >
                                    Allow
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => handleDenyStudent(student.socketId)}
                                    style={{ background: 'rgba(239, 68, 68, 0.2)', color: '#ef4444', border: '1px solid #ef4444', borderRadius: '4px', padding: '2px 6px', fontSize: '0.74rem', fontWeight: 700, cursor: 'pointer' }}
                                  >
                                    Deny
                                  </button>
                                </div>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                    </>
                  )}

                  {/* Connected Participants Header */}
                  <div className="participants-list-header">
                    <span>Connected ({participants.length || 1})</span>
                    <span className="status-live-dot">● Live</span>
                  </div>

                  {/* Participants List */}
                  <div className="participants-scroll">
                    {participants.length === 0 ? (
                      <div className="participant-item current-user">
                        <div className="participant-main-row">
                          <div className="participant-avatar">{isInstructor ? '👨‍🏫' : '🎓'}</div>
                          <div className="participant-info">
                            <span className="participant-name">{user?.name || 'You'} (You)</span>
                            <span className={`participant-role-tag ${isInstructor ? 'role-host' : 'role-student'}`}>
                              {isInstructor ? 'Instructor / Host' : 'Student'}
                            </span>
                          </div>
                        </div>
                      </div>
                    ) : (
                      participants.map((p) => {
                        const isSelf = p.socketId === socket.id;
                        const hasHand = handRaisedUsers[p.socketId] || handRaisedUsers[p.userId] || (p.userName && handRaisedUsers[p.userName]) || (isSelf && hasHandRaised);
                        const eng = engagementStats[p.socketId];
                        const isPeerMuted = peerMediaStates[p.socketId]?.micOn === false;

                        return (
                          <div key={p.socketId} className={`participant-item ${isSelf ? 'current-user' : ''}`}>
                            <div className="participant-main-row">
                              <div className="participant-avatar">{p.userRole === 'instructor' ? '👨‍🏫' : '🎓'}</div>
                              <div className="participant-info">
                                <span className="participant-name">
                                  {p.userName} {isSelf && '(You)'}
                                </span>
                                <div className="participant-tags-row">
                                  <span className={`participant-role-tag ${p.userRole === 'instructor' ? 'role-host' : 'role-student'}`}>
                                    {p.userRole === 'instructor' ? 'Instructor / Host' : 'Student'}
                                  </span>

                                  {hasHand && (
                                    <span className="hand-raise-tag" title={hasHand.time ? `Hand raised at ${hasHand.time}` : 'Hand raised'}>
                                      ✋ Raised Hand
                                    </span>
                                  )}

                                  {eng && p.userRole !== 'instructor' && (
                                    <span
                                      className={`focus-tag ${eng.isFocused ? 'focused' : 'unfocused'}`}
                                      title={`Live focus score: ${eng.score}%`}
                                    >
                                      {eng.isFocused ? '👀 Focused' : '⚠️ Inactive'}
                                    </span>
                                  )}
                                  {peerMediaStates[p.socketId] && (
                                    <span className="media-status-tag">
                                      {peerMediaStates[p.socketId].micOn ? '🎙️ Mic' : '🔇 Muted'} • {peerMediaStates[p.socketId].videoOn ? '📹 Cam' : '🚫 Cam Off'}
                                    </span>
                                  )}
                                </div>
                              </div>
                            </div>

                            {/* Individual student control buttons for Host */}
                            {isInstructor && !isSelf && (
                              <div className="participant-host-controls">
                                {hasHand && (
                                  <button
                                    type="button"
                                    className="btn-participant-ctrl"
                                    style={{ background: 'rgba(234, 88, 12, 0.2)', borderColor: '#ea580c', color: '#fb923c', fontWeight: 700 }}
                                    onClick={() => {
                                      socket.emit('lower-hand', { roomId: cleanRoomId(roomId), socketId: p.socketId, userId: p.userId });
                                      setHandRaisedUsers(prev => {
                                        const next = { ...prev };
                                        delete next[p.socketId];
                                        delete next[p.userId];
                                        if (p.userName) delete next[p.userName];
                                        return next;
                                      });
                                      showToast(`Lowered ${p.userName}'s hand`);
                                    }}
                                    title={`Lower ${p.userName}'s hand`}
                                  >
                                    ✋ Lower Hand
                                  </button>
                                )}
                                <button
                                  type="button"
                                  className="btn-participant-ctrl"
                                  onClick={() => handleHostMuteStudent(p.socketId, p.userName, isPeerMuted ? false : true)}
                                  title={isPeerMuted ? `Unlock microphone for ${p.userName}` : `Mute & lock ${p.userName}`}
                                >
                                  {isPeerMuted ? '🎙️ Unmute' : '🔇 Mute'}
                                </button>
                                <button
                                  type="button"
                                  className="btn-participant-ctrl"
                                  onClick={() => {
                                    const isCamOff = peerMediaStates[p.socketId]?.videoOn === false;
                                    handleHostToggleStudentCamera(p.socketId, p.userName, isCamOff);
                                  }}
                                  title={`Toggle camera for ${p.userName}`}
                                >
                                  {peerMediaStates[p.socketId]?.videoOn === false ? '📹 Cam On' : '🚫 Cam Off'}
                                </button>
                                <button
                                  type="button"
                                  className="btn-remove-participant"
                                  onClick={() => handleRemoveParticipant(p.socketId, p.userName)}
                                  title={`Remove ${p.userName} from classroom`}
                                >
                                  🚫 Remove
                                </button>
                              </div>
                            )}
                          </div>
                        );
                      })
                    )}
                  </div>
                </div>
              )}
            </div>
          </aside>
        )}
      </div>

      {/* ── Footer Controls (Zoom-Style Matching Images 1, 3, 4, 5) ── */}
      <footer className="room-footer" ref={footerRef}>
        <div className="room-footer-center-controls">
          {/* 1. Audio Control Group (Image 3) */}
          <div className="zoom-toolbar-btn-group" style={{ position: 'relative' }}>
          <button
            type="button"
            className={`zoom-main-btn ${!micOn ? 'muted-btn' : ''}`}
            onClick={toggleMic}
            title={!isInstructor && isMutedByHost ? 'Microphone locked by instructor' : (micOn ? 'Mute Audio' : 'Unmute Audio')}
          >
            <div className="zoom-btn-icon">
              {!isInstructor && isMutedByHost ? (
                <span style={{ fontSize: '1.05rem' }}>🔒</span>
              ) : micOn ? (
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z"/>
                  <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
                  <line x1="12" y1="19" x2="12" y2="23"/>
                  <line x1="8" y1="23" x2="16" y2="23"/>
                </svg>
              ) : (
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="2" y1="2" x2="22" y2="22" stroke="#ef4444" strokeWidth="2.5" />
                  <path d="M18.89 13.23A7.12 7.12 0 0 0 19 12v-2" stroke="#ffffff" />
                  <path d="M5 10v2a7 7 0 0 0 12 5" stroke="#ffffff" />
                  <path d="M15 9.34V5a3 3 0 0 0-5.68-1.33" stroke="#ffffff" />
                  <path d="M9 9v3a3 3 0 0 0 5.12 2.12" stroke="#ffffff" />
                  <line x1="12" y1="19" x2="12" y2="23" stroke="#ffffff" />
                  <line x1="8" y1="23" x2="16" y2="23" stroke="#ffffff" />
                </svg>
              )}
            </div>
            <span className="zoom-btn-label">{!isInstructor && isMutedByHost ? 'Locked' : 'Audio'}</span>
          </button>

          <button
            type="button"
            className={`zoom-arrow-btn ${isAudioMenuOpen ? 'open' : ''}`}
            onClick={(e) => {
              e.stopPropagation();
              setIsAudioMenuOpen(prev => !prev);
              setIsVideoMenuOpen(false);
              setIsParticipantsMenuOpen(false);
            }}
            title="Audio Options"
          >
            ▲
          </button>

          {/* Audio Options Popup Menu (Matching Image 3) */}
          {isAudioMenuOpen && (
            <div className="zoom-popup-menu" onClick={e => e.stopPropagation()}>
              <div className="zoom-menu-section-header">Select a microphone</div>
              {availableMics.map(m => (
                <button
                  key={m.deviceId}
                  type="button"
                  className={`zoom-menu-item ${selectedMicId === m.deviceId ? 'checked' : ''}`}
                  onClick={() => {
                    handleSwitchMicrophone(m.deviceId);
                  }}
                >
                  <span className="item-text">{m.label}</span>
                  {selectedMicId === m.deviceId && <span className="check-icon">✓</span>}
                </button>
              ))}

              <div className="zoom-menu-divider" />

              <div className="zoom-menu-section-header">Select a speaker</div>
              {availableSpeakers.map(s => (
                <button
                  key={s.deviceId}
                  type="button"
                  className={`zoom-menu-item ${selectedSpeakerId === s.deviceId ? 'checked' : ''}`}
                  onClick={() => {
                    handleSwitchSpeaker(s.deviceId);
                  }}
                >
                  <span className="item-text">{s.label}</span>
                  {selectedSpeakerId === s.deviceId && <span className="check-icon">✓</span>}
                </button>
              ))}

              <div className="zoom-menu-divider" />

              <div className="zoom-menu-section-header">Microphone modes</div>
              {[
                { id: 'noise-removal', label: 'Noise removal (default)' },
                { id: 'isolation', label: 'Personalized audio isolation' },
                { id: 'musicians', label: 'Original sound for musicians' }
              ].map(mode => (
                <button
                  key={mode.id}
                  type="button"
                  className={`zoom-menu-item ${micMode === mode.id ? 'checked' : ''}`}
                  onClick={() => {
                    setMicMode(mode.id);
                    showToast(`Audio mode: ${mode.label}`);
                  }}
                >
                  <span className="item-text">{mode.label}</span>
                  {micMode === mode.id && <span className="check-icon">✓</span>}
                </button>
              ))}

              <div className="zoom-menu-divider" />

              <button
                type="button"
                className="zoom-menu-item action-item"
                onClick={handleTestAudioAndMic}
              >
                <span className="item-text">Test speaker & microphone</span>
              </button>

              <button
                type="button"
                className="zoom-menu-item action-item"
                onClick={() => {
                  if (micOn) toggleMic();
                  showToast('Left computer audio.');
                  setIsAudioMenuOpen(false);
                }}
              >
                <span className="item-text">Leave computer audio</span>
              </button>

              <div className="zoom-menu-divider" />

              <button
                type="button"
                className="zoom-menu-item action-item"
                onClick={() => {
                  setIsAudioMenuOpen(false);
                  if (onOpenSettings) onOpenSettings('audio');
                }}
              >
                <span className="item-text">Audio settings...</span>
              </button>
            </div>
          )}
        </div>

        {/* Live Captions Control */}
        <div className="zoom-toolbar-btn-group" style={{ position: 'relative' }}>
          <button
            type="button"
            className={`zoom-main-btn ${isLiveCaptionsOn ? 'live-captions-active' : ''}`}
            onClick={handleToggleLiveCaptions}
            aria-pressed={isLiveCaptionsOn}
            title={isLiveCaptionsOn ? 'Turn live captions off' : 'Turn live captions on'}
            style={isLiveCaptionsOn ? { borderColor: '#06b6d4', color: '#67e8f9', background: 'rgba(8, 145, 178, 0.18)' } : undefined}
          >
            <div className="zoom-btn-icon" style={{ fontSize: '18px', fontWeight: 800, letterSpacing: '-1px' }}>CC</div>
            <span className="zoom-btn-label">{isLiveCaptionsOn ? 'Captions On' : 'Captions'}</span>
          </button>
        </div>

        {/* 2. Video Control Group (Image 4) */}
        <div className="zoom-toolbar-btn-group" style={{ position: 'relative' }}>
          <button
            type="button"
            className={`zoom-main-btn ${!videoOn ? 'muted-btn' : ''}`}
            onClick={toggleVideo}
            title={videoOn ? 'Turn Off Video' : 'Start Video'}
          >
            <div className="zoom-btn-icon">
              {videoOn ? (
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M23 7l-7 5 7 5V7z" fill="currentColor"/>
                  <rect x="1" y="5" width="15" height="14" rx="2" ry="2"/>
                </svg>
              ) : (
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="2" y1="2" x2="22" y2="22" stroke="#ef4444" strokeWidth="2.5" />
                  <path d="M16 16v1a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h2m4 0h5a2 2 0 0 1 2 2v3l7-5v14l-4-2.86" stroke="#ffffff" />
                </svg>
              )}
            </div>
            <span className="zoom-btn-label">Video</span>
          </button>

          <button
            type="button"
            className={`zoom-arrow-btn ${isVideoMenuOpen ? 'open' : ''}`}
            onClick={(e) => {
              e.stopPropagation();
              setIsVideoMenuOpen(prev => !prev);
              setIsAudioMenuOpen(false);
              setIsParticipantsMenuOpen(false);
            }}
            title="Video Options"
          >
            ▲
          </button>

          {/* Video Options Popup Menu (Matching Image 4) */}
          {isVideoMenuOpen && (
            <div className="zoom-popup-menu" onClick={e => e.stopPropagation()}>
              <div className="zoom-menu-section-header">Select a camera</div>
              {availableCameras.map(c => (
                <button
                  key={c.deviceId}
                  type="button"
                  className={`zoom-menu-item ${selectedCameraId === c.deviceId ? 'checked' : ''}`}
                  onClick={() => {
                    setSelectedCameraId(c.deviceId);
                    showToast(`📹 Camera: ${c.label}`);
                  }}
                >
                  <span className="item-text">{c.label}</span>
                  {selectedCameraId === c.deviceId && <span className="check-icon">✓</span>}
                </button>
              ))}

              <div className="zoom-menu-divider" />

              {/* Blur my background toggle switch */}
              <div
                className="zoom-menu-toggle-row"
                onClick={() => {
                  setIsBackgroundBlurred(prev => {
                    const nxt = !prev;
                    showToast(nxt ? '✨ Background blur enabled!' : 'Background blur disabled.');
                    return nxt;
                  });
                }}
              >
                <span>Blur my background</span>
                <div className={`zoom-toggle-switch ${isBackgroundBlurred ? 'on' : ''}`}>
                  <div className="zoom-toggle-thumb" />
                </div>
              </div>

              {/* Auto-frame my video toggle switch */}
              <div
                className="zoom-menu-toggle-row"
                onClick={() => {
                  setIsAutoFramed(prev => {
                    const nxt = !prev;
                    showToast(nxt ? '🔍 Auto-frame enabled!' : 'Auto-frame disabled.');
                    return nxt;
                  });
                }}
              >
                <span>Auto-frame my video</span>
                <div className={`zoom-toggle-switch ${isAutoFramed ? 'on' : ''}`}>
                  <div className="zoom-toggle-thumb" />
                </div>
              </div>

              <div className="zoom-menu-divider" />

              <button
                type="button"
                className="zoom-menu-item action-item"
                onClick={() => {
                  showToast('Video & Effects Settings: HD resolution & AI stabilization active.');
                  setIsVideoMenuOpen(false);
                }}
              >
                <span className="item-text">Video & effects settings</span>
              </button>
            </div>
          )}
        </div>

        {/* 3. Participants Control Group (Image 5) */}
        <div className="zoom-toolbar-btn-group" style={{ position: 'relative' }}>
          <button
            type="button"
            className={`zoom-main-btn ${activeTab === 'host' ? 'active-tab-btn' : ''}`}
            onClick={() => setActiveTab(prev => prev === 'host' ? null : 'host')}
            title="View Participants"
          >
            <div className="zoom-btn-icon">
              <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
                  <circle cx="9" cy="7" r="4" />
                  <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
                  <path d="M16 3.13a4 4 0 0 1 0 7.75" />
                </svg>
                <span style={{ fontSize: '0.82rem', fontWeight: 800, color: '#f1f5f9' }}>{participants.length || 1}</span>
              </div>
            </div>
            <span className="zoom-btn-label">Participants</span>
          </button>

          <button
            type="button"
            className={`zoom-arrow-btn ${isParticipantsMenuOpen ? 'open' : ''}`}
            onClick={(e) => {
              e.stopPropagation();
              setIsParticipantsMenuOpen(prev => !prev);
              setIsAudioMenuOpen(false);
              setIsVideoMenuOpen(false);
              setIsHostToolsOpen(false);
              setIsMeetingInfoOpen(false);
            }}
            title="Participants Menu"
          >
            ▲
          </button>

          {/* Participants Popup Menu (Matching Image 5) */}
          {isParticipantsMenuOpen && (
            <div className="zoom-popup-menu" onClick={e => e.stopPropagation()}>
              <button
                type="button"
                className="zoom-menu-item action-item"
                onClick={() => {
                  copyClassInvitation();
                  setIsParticipantsMenuOpen(false);
                }}
              >
                <span className="item-text">Invite...</span>
                <span style={{ fontSize: '0.72rem', color: '#94a3b8' }}>Alt+I</span>
              </button>

              <button
                type="button"
                className="zoom-menu-item action-item"
                onClick={() => {
                  copyInviteLink();
                  setIsParticipantsMenuOpen(false);
                }}
              >
                <span className="item-text">Copy invite link</span>
                <span style={{ fontSize: '0.72rem', color: '#94a3b8' }}>Alt+Shift+I</span>
              </button>

              {isInstructor && (
                <>
                  <div className="zoom-menu-divider" />
                  <button
                    type="button"
                    className="zoom-menu-item action-item"
                    onClick={() => {
                      handleHostMuteAll();
                      setIsParticipantsMenuOpen(false);
                    }}
                  >
                    <span className="item-text">Host tools for participants</span>
                  </button>
                  <button
                    type="button"
                    className="zoom-menu-item action-item"
                    onClick={() => {
                      handleToggleRoomLock();
                      setIsParticipantsMenuOpen(false);
                    }}
                  >
                    <span className="item-text">{isRoomLocked ? 'Unlock Classroom' : 'Lock Classroom'}</span>
                  </button>
                </>
              )}

              <div className="zoom-menu-divider" />

              <button
                type="button"
                className="zoom-menu-item action-item"
                onClick={() => {
                  setActiveTab('host');
                  setIsParticipantsMenuOpen(false);
                }}
              >
                <span className="item-text">Open Participants Panel</span>
              </button>
            </div>
          )}
        </div>

        {/* 4. Chat Button (Toggles sidebar panel on click with unread notifications) */}
        <div className="zoom-toolbar-btn-group">
          {(() => {
            const totalUnread = (unreadChatCount || 0) + (pinnedDoubts.length || 0);
            return (
              <button
                type="button"
                className={`zoom-main-btn ${activeTab === 'chat' ? 'active-tab-btn' : ''}`}
                onClick={() => {
                  setActiveTab(prev => {
                    const next = prev === 'chat' ? null : 'chat';
                    if (next === 'chat') setUnreadChatCount(0);
                    return next;
                  });
                }}
                title={totalUnread > 0 ? `${totalUnread} new notification(s)` : "Open Live Chat"}
              >
                <div className="zoom-btn-icon" style={{ position: 'relative' }}>
                  💬
                  {totalUnread > 0 && activeTab !== 'chat' && (
                    <span
                      style={{
                        position: 'absolute',
                        top: -5,
                        right: -7,
                        background: unreadChatCount > 0 ? '#0284c7' : '#ef4444',
                        color: '#fff',
                        borderRadius: '50%',
                        padding: '1px 5px',
                        fontSize: '0.62rem',
                        fontWeight: 900,
                        boxShadow: unreadChatCount > 0 ? '0 0 10px rgba(2, 132, 199, 0.9)' : '0 0 8px rgba(239, 68, 68, 0.8)'
                      }}
                    >
                      {totalUnread}
                    </span>
                  )}
                </div>
                <span className="zoom-btn-label">
                  Chat {totalUnread > 0 && activeTab !== 'chat' ? `(${totalUnread})` : ''}
                </span>
              </button>
            );
          })()}
        </div>

        </div>

        {/* Right Side: Meeting Info (Corner) & End / Leave */}
        <div className="room-footer-right-group">
          {/* Meeting Info Button */}
          <div className="zoom-toolbar-btn-group" style={{ position: 'relative' }}>
            <button
              type="button"
              className={`zoom-main-btn ${isMeetingInfoOpen ? 'active-tab-btn' : ''}`}
              onClick={(e) => {
                e.stopPropagation();
                setIsMeetingInfoOpen(prev => !prev);
                setIsAudioMenuOpen(false);
                setIsVideoMenuOpen(false);
                setIsParticipantsMenuOpen(false);
              }}
              title="Classroom Info, WiFi LAN IP & Shareable Links"
            >
              <div className="zoom-btn-icon">ℹ️</div>
              <span className="zoom-btn-label">Meeting Info</span>
            </button>

          </div>
        </div>
      </footer>

      {/* Meeting Info Flyout Card (Rendered outside footer to prevent mobile containment/clipping) */}
            {isMeetingInfoOpen && (
              <div className="zoom-meeting-info-flyout footer-flyout" ref={meetingInfoRef} onClick={e => e.stopPropagation()}>
                <div className="zoom-flyout-header">
                  <div className="zoom-info-title-wrap">
                    <div className="zoom-info-meeting-title" style={{ fontSize: '1rem', fontWeight: 800, color: theme === 'light' ? '#0f172a' : '#f8fafc', lineHeight: 1.2 }}>SyncLearn Meeting</div>
                    <span style={{ fontSize: '0.72rem', color: theme === 'light' ? '#64748b' : '#94a3b8' }}>Classroom • Encrypted</span>
                  </div>
                  <button
                    type="button"
                    className="zoom-flyout-icon-btn"
                    onClick={() => setIsMeetingInfoOpen(false)}
                    title="Close"
                  >
                    ✕
                  </button>
                </div>

                <div className="zoom-info-divider-line" />

                <div className="zoom-info-field-group">
                  <span className="zoom-info-field-title">Meeting ID</span>
                  <div className="zoom-info-field-value-row">
                    <span className="zoom-info-field-val">{formatMeetingIdWithDashes(roomId)}</span>
                    <button
                      type="button"
                      className="zoom-info-copy-btn"
                      onClick={() => {
                        navigator.clipboard?.writeText(formatMeetingIdWithDashes(roomId));
                        showToast('📋 Meeting ID copied!');
                      }}
                      title="Copy Meeting ID"
                    >
                      Copy
                    </button>
                  </div>
                </div>

                <div className="zoom-info-field-group">
                  <span className="zoom-info-field-title">Host</span>
                  <div className="zoom-info-field-value-row">
                    <span className="zoom-info-field-val">{user?.name || 'Instructor'}</span>
                  </div>
                </div>

                {isInstructor && (
                  <div className="zoom-info-field-group">
                    <span className="zoom-info-field-title">Passcode</span>
                    <div className="zoom-info-field-value-row">
                      <span className="zoom-info-field-val" style={{ fontWeight: 800, color: '#38bdf8' }}>{roomPasscode}</span>
                      <button
                        type="button"
                        className="zoom-info-copy-btn"
                        onClick={() => {
                          navigator.clipboard?.writeText(roomPasscode);
                          showToast('📋 Passcode copied!');
                        }}
                        title="Copy Passcode"
                      >
                        Copy
                      </button>
                      <button
                        type="button"
                        className="zoom-info-copy-btn"
                        style={{ background: 'rgba(2, 132, 199, 0.25)', borderColor: '#38bdf8', color: '#38bdf8' }}
                        onClick={() => {
                          const newPass = generateMeetingPasscode();
                          setRoomPasscode(newPass);
                          roomPasscodeRef.current = newPass;
                          window.__synclearnRoomPasscode = newPass;
                          try {
                            const cleanR = cleanRoomId(roomId);
                            localStorage.setItem('synclearn_passcode_' + cleanR, newPass);
                            localStorage.setItem('synclearn_passcode_' + roomId, newPass);
                          } catch(e) {}
                          socket.emit('set-room-passcode', { roomId: cleanRoomId(roomId), passcode: newPass });
                          showToast(`✨ Passcode changed to: ${newPass}`, 'success');
                        }}
                        title="Generate a new passcode for this meeting"
                      >
                        🔄 Change
                      </button>
                    </div>
                  </div>
                )}

                {/* 1. Mobile & WhatsApp Direct Shareable Link (HTTPS Cloudflare) - Instructor Only */}
                {isInstructor && (
                  <>
                    <div className="zoom-info-field-group">
                      <span className="zoom-info-field-title" style={{ color: '#22c55e', display: 'flex', alignItems: 'center', gap: '4px', fontWeight: 700 }}>
                        <span>📱 WhatsApp & Mobile Link</span>
                      </span>
                      <div className="zoom-info-field-value-row">
                        <span className="zoom-info-field-val zoom-info-green-link" style={{ fontSize: '0.72rem', wordBreak: 'break-all', fontWeight: 700, color: '#22c55e' }}>
                          {getShareableLink(false)}
                        </span>
                        <button
                          type="button"
                          className="zoom-info-copy-btn"
                          style={{
                            background: 'rgba(34, 197, 94, 0.2)',
                            borderColor: '#22c55e',
                            color: '#22c55e',
                            fontWeight: 700
                          }}
                          onClick={() => copyInviteLink(false)}
                          title="Copy WhatsApp & Mobile Link"
                        >
                          Copy Link
                        </button>
                      </div>
                    </div>

                    {/* 3. Local PC Link */}
                    <div className="zoom-info-field-group">
                      <span className="zoom-info-field-title" style={{ color: theme === 'light' ? '#0369a1' : '#38bdf8', fontWeight: 700 }}>💻 Local PC Link</span>
                      <div className="zoom-info-field-value-row">
                        <span className="zoom-info-field-val" style={{ fontSize: '0.68rem', wordBreak: 'break-all', color: theme === 'light' ? '#0284c7' : '#7dd3fc' }}>
                          {getShareableLink(true)}
                        </span>
                        <button
                          type="button"
                          className="zoom-info-copy-btn"
                          onClick={() => copyInviteLink(true)}
                          title="Copy Local PC Link"
                        >
                          Copy PC
                        </button>
                      </div>
                    </div>
                  </>
                )}
              </div>
            )}

      {/* ── Instructor Leave Confirmation Modal ── */}
      {isLeaveModalOpen && (
        <div
          className="synclearn-modal-backdrop"
          onClick={() => setIsLeaveModalOpen(false)}
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(2, 6, 23, 0.78)',
            backdropFilter: 'blur(8px)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 99999
          }}
        >
          <div
            className="synclearn-modal-dialog"
            onClick={e => e.stopPropagation()}
            style={{
              width: '90%',
              maxWidth: '460px',
              background: 'linear-gradient(180deg, #0b1d33 0%, #061527 100%)',
              border: '1.5px solid rgba(56, 189, 248, 0.35)',
              borderRadius: '14px',
              boxShadow: '0 20px 45px rgba(0, 0, 0, 0.75)',
              overflow: 'hidden'
            }}
          >
            <div style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              padding: '1rem 1.25rem',
              borderBottom: '1px solid rgba(56, 189, 248, 0.2)'
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <span style={{ fontSize: '1.25rem' }}>🚪</span>
                <h3 style={{ margin: 0, color: '#f8fafc', fontSize: '1rem', fontWeight: 800 }}>
                  Leave Classroom
                </h3>
              </div>
              <button
                type="button"
                className="panel-close-btn"
                onClick={() => setIsLeaveModalOpen(false)}
                title="Cancel"
                style={{ fontSize: '1rem', cursor: 'pointer' }}
              >
                ✕
              </button>
            </div>

            <div style={{ padding: '1.25rem', display: 'flex', flexDirection: 'column', gap: '0.9rem' }}>
              <p style={{ margin: 0, color: '#94a3b8', fontSize: '0.85rem', lineHeight: 1.5 }}>
                You are currently hosting this live classroom. Please choose an exit action:
              </p>

              {/* Option 1: Leave Meeting (Instructor leaves only) */}
              <button
                type="button"
                onClick={() => {
                  setIsLeaveModalOpen(false);
                  handleRecordSessionHistoryAndLeave();
                }}
                style={{
                  background: 'rgba(10, 34, 62, 0.85)',
                  border: '1.5px solid rgba(56, 189, 248, 0.35)',
                  borderRadius: 10,
                  padding: '0.85rem 1rem',
                  display: 'flex',
                  alignItems: 'flex-start',
                  gap: 12,
                  cursor: 'pointer',
                  textAlign: 'left',
                  transition: 'all 0.15s ease'
                }}
                onMouseEnter={e => e.currentTarget.style.borderColor = '#38bdf8'}
                onMouseLeave={e => e.currentTarget.style.borderColor = 'rgba(56, 189, 248, 0.35)'}
              >
                <span style={{ fontSize: '1.35rem', marginTop: 2 }}>🚶‍♂️</span>
                <div>
                  <div style={{ fontWeight: 700, color: '#f8fafc', fontSize: '0.88rem' }}>Leave Meeting</div>
                  <div style={{ fontSize: '0.74rem', color: '#94a3b8', marginTop: 3 }}>
                    Only you exit the classroom. Students remain in session and can continue discussions.
                  </div>
                </div>
              </button>

              {/* Option 2: End Meeting for All */}
              <button
                type="button"
                onClick={() => {
                  setIsLeaveModalOpen(false);
                  socket.emit('end-meeting-for-all', { roomId: cleanRoomId(roomId) });
                  handleRecordSessionHistoryAndLeave();
                }}
                style={{
                  background: 'linear-gradient(135deg, rgba(239, 68, 68, 0.22) 0%, rgba(185, 28, 28, 0.35) 100%)',
                  border: '1.5px solid #ef4444',
                  borderRadius: 10,
                  padding: '0.85rem 1rem',
                  display: 'flex',
                  alignItems: 'flex-start',
                  gap: 12,
                  cursor: 'pointer',
                  textAlign: 'left',
                  transition: 'all 0.15s ease'
                }}
                onMouseEnter={e => e.currentTarget.style.boxShadow = '0 0 16px rgba(239, 68, 68, 0.45)'}
                onMouseLeave={e => e.currentTarget.style.boxShadow = 'none'}
              >
                <span style={{ fontSize: '1.35rem', marginTop: 2 }}>🛑</span>
                <div>
                  <div style={{ fontWeight: 800, color: '#fca5a5', fontSize: '0.88rem' }}>End Meeting for All</div>
                  <div style={{ fontSize: '0.74rem', color: '#cbd5e1', marginTop: 3 }}>
                    Complete the entire session. All students will be safely disconnected and returned to dashboard.
                  </div>
                </div>
              </button>
            </div>

            <div style={{ padding: '0.75rem 1.25rem', borderTop: '1px solid rgba(56, 189, 248, 0.18)', display: 'flex', justifyContent: 'flex-end' }}>
              <button
                type="button"
                onClick={() => setIsLeaveModalOpen(false)}
                style={{
                  background: 'transparent',
                  border: '1px solid #475569',
                  color: '#94a3b8',
                  borderRadius: 6,
                  padding: '6px 14px',
                  fontSize: '0.8rem',
                  cursor: 'pointer'
                }}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default ActiveRoomPage;