const Room = require('../models/Room');

// In-memory room state
const lockedRooms = new Set();
const roomLockedChats = new Set(); // roomId -> boolean for student chat lock
const roomStudentDrawingAllowed = new Set(); // roomId -> boolean for student whiteboard draw
const roomUsers = new Map(); // roomId -> Map(socketId -> userObj)
const roomVideoStates = new Map(); // roomId -> { mediaType, ytVideoId, videoSrc, currentTime, isPlaying, videoTitle }
const roomWorkspaceViews = new Map(); // roomId -> view
const roomActiveQuizzes = new Map(); // roomId -> active quiz object
const roomMediaStates = new Map(); // roomId -> Map(socketId -> { videoOn, micOn })
const roomInstructors = new Map(); // roomId -> instructorName
const roomTopics = new Map(); // roomId -> current lecture topic
const roomPasscodes = new Map(); // roomId -> 6-char secure enrollment passcode

const generatePasscode = () => {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
};

// Student Admission Waiting Room
const pendingAdmissions = new Map(); // roomId -> Map(socketId -> { socketId, userId, userName, userRole, photo, timestamp })
const admittedSockets = new Set(); // Set(socketId) of admitted students

const getInstructorSockets = (roomId) => {
  const sockets = [];
  const currentMap = roomUsers.get(roomId);
  if (currentMap) {
    for (const [sId, u] of currentMap.entries()) {
      if (u.userRole === 'instructor') sockets.push(sId);
    }
  }
  return sockets;
};

const sanitizeRoomId = (raw) => {
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

const getCanonicalRoomId = (raw) => {
  if (!raw) return '';
  const clean = sanitizeRoomId(raw);
  const noHyphen = clean.replace(/-/g, '');
  if (/^\d{9}$/.test(noHyphen)) {
    return `${noHyphen.slice(0, 3)}-${noHyphen.slice(3, 6)}-${noHyphen.slice(6)}`;
  }
  return clean;
};

const getRoomVariants = (raw) => {
  if (!raw) return [];
  const clean = sanitizeRoomId(raw);
  if (!clean) return [];
  const noHyphen = clean.replace(/-/g, '');
  const variants = new Set([clean, noHyphen]);
  if (/^\d{9}$/.test(noHyphen)) {
    variants.add(`${noHyphen.slice(0, 3)}-${noHyphen.slice(3, 6)}-${noHyphen.slice(6)}`);
  }
  return Array.from(variants);
};

const syncHandler = (io, socket) => {
  console.log('⚡ User Connected:', socket.id);

  // ── Room Join ──
  socket.on('join-room', ({ roomId: rawRoomId, userId, userName, userRole, roomTopic }) => {
    const canonicalRoomId = getCanonicalRoomId(rawRoomId);
    const roomId = canonicalRoomId || sanitizeRoomId(rawRoomId);
    // Check if room is locked
    if (lockedRooms.has(roomId) && userRole !== 'instructor') {
      socket.emit('room-locked-error', { message: 'This room has been locked by the instructor.' });
      return;
    }

    const variants = getRoomVariants(rawRoomId);
    variants.forEach(v => socket.join(v));
    socket.roomId = roomId;

    if (roomTopic && typeof roomTopic === 'string' && roomTopic.trim()) {
      const cleanT = roomTopic.trim();
      variants.forEach(v => {
        if (!roomTopics.has(v) || userRole === 'instructor') {
          roomTopics.set(v, cleanT);
        }
      });
    }

    if (!roomUsers.has(roomId)) {
      roomUsers.set(roomId, new Map());
    }
    const currentRoomMap = roomUsers.get(roomId);
    const isNewToRoom = !currentRoomMap.has(socket.id);
    currentRoomMap.set(socket.id, {
      socketId: socket.id,
      userId: userId || socket.id,
      userName: userName || (userRole === 'instructor' ? 'Instructor' : `Student #${socket.id.substring(0,4)}`),
      userRole: userRole || 'student'
    });

    console.log(`👤 User ${userId || socket.id} (${userName || userRole}) joined Room: ${roomId} (new: ${isNewToRoom})`);
    
    // Persist Room and Session Participants directly to MongoDB
    (async () => {
      try {
        const updateDoc = {
          isActive: true,
          studentsCount: currentRoomMap.size,
          participants: Array.from(currentRoomMap.values()).map(u => ({
            socketId: u.socketId,
            userName: u.userName,
            userRole: u.userRole,
            joinedAt: new Date()
          }))
        };
        if (userRole === 'instructor') {
          updateDoc.instructorName = userName || 'Instructor';
        }
        await Room.findOneAndUpdate(
          { roomId },
          {
            $set: updateDoc,
            $setOnInsert: { title: `Live Classroom (${roomId})` }
          },
          { upsert: true, returnDocument: 'after' }
        );
        console.log(`💾 Persisted room "${roomId}" to MongoDB (synclearn_app.rooms)`);

        // Also ensure user exists in synclearn_app.users
        const User = require('../models/User');
        const effectiveName = (userName || (userRole === 'instructor' ? 'Instructor' : 'Student')).trim();
        const safeName = effectiveName.toLowerCase().replace(/[^a-z0-9]/g, '');
        const autoEmail = `${safeName || 'user'}@student.synclearn.edu`;

        await User.findOneAndUpdate(
          { name: effectiveName },
          {
            $set: {
              name: effectiveName,
              role: userRole || 'student',
              lastLogin: new Date()
            },
            $setOnInsert: {
              email: autoEmail,
              password: '$2b$10$autogeneratedStudentPasswordPlaceholder'
            }
          },
          { upsert: true, returnDocument: 'after' }
        );
        console.log(`💾 Persisted user "${effectiveName}" to MongoDB (synclearn_app.users)`);
      } catch (err) {
        console.warn('MongoDB room/user persist error:', err.message);
      }
    })();

    // Mark socket as admitted
    if (userRole === 'instructor' || admittedSockets.has(socket.id)) {
      admittedSockets.add(socket.id);
    }

    // Notify peers for WebRTC ONLY if this socket is newly joining (prevents duplicate peer negotiation loops)
    if (isNewToRoom) {
      socket.to(roomId).emit('user-connected', socket.id);
    }

    if (userRole === 'instructor') {
      const instName = userName || 'Instructor';
      variants.forEach(v => roomInstructors.set(v, instName));

      // Resolve room passcode and sync to instructor
      let curPasscode = roomPasscodes.get(roomId);
      if (!curPasscode) {
        Room.findOne({ roomId }).lean().then(r => {
          if (r && r.passcode) {
            curPasscode = r.passcode;
          } else {
            curPasscode = generatePasscode();
            Room.findOneAndUpdate({ roomId }, { $set: { passcode: curPasscode } }).catch(() => {});
          }
          roomPasscodes.set(roomId, curPasscode);
          variants.forEach(v => roomPasscodes.set(v, curPasscode));
          socket.emit('room-passcode', { passcode: curPasscode });
        }).catch(() => {
          curPasscode = generatePasscode();
          roomPasscodes.set(roomId, curPasscode);
          variants.forEach(v => roomPasscodes.set(v, curPasscode));
          socket.emit('room-passcode', { passcode: curPasscode });
        });
      } else {
        socket.emit('room-passcode', { passcode: curPasscode });
      }
    }

    // Broadcast updated participant roster to the room and to current socket
    const participantList = Array.from(currentRoomMap.values());
    io.to(roomId).emit('room-participants-update', participantList);
    socket.emit('room-lock-status', { isLocked: lockedRooms.has(roomId) });
    socket.emit('chat-lock-status', { isLocked: roomLockedChats.has(roomId) });
    socket.emit('whiteboard-student-draw-status', { allowed: roomStudentDrawingAllowed.has(roomId) });

    // Send existing media states of participants
    let foundStates = null;
    for (const v of variants) {
      if (roomMediaStates.has(v)) {
        foundStates = roomMediaStates.get(v);
        break;
      }
    }
    if (foundStates) {
      const currentStates = {};
      for (const [sId, st] of foundStates.entries()) {
        currentStates[sId] = st;
      }
      socket.emit('room-media-states-sync', currentStates);
    }

    // Send instructor name if available
    let curInst = null;
    for (const v of variants) {
      if (roomInstructors.has(v)) {
        curInst = roomInstructors.get(v);
        break;
      }
    }
    if (curInst) {
      socket.emit('room-instructor-info', { instructorName: curInst });
    }

    // Broadcast user joined toast notification once to peers in the room
    socket.to(roomId).emit('peer-joined-notification', {
      userName: userName || (userRole === 'instructor' ? 'Instructor' : 'A student'),
      userRole: userRole || 'student',
      totalCount: currentRoomMap.size
    });

    // Send existing workspace view & video state to newly joined user
    if (roomWorkspaceViews.has(roomId)) {
      socket.emit('workspace-view-sync', { view: roomWorkspaceViews.get(roomId) });
    }
    if (roomVideoStates.has(roomId)) {
      socket.emit('video-source-change', roomVideoStates.get(roomId));
    }
    // (Quiz auto-popup on join removed as requested)

    let currentTopic = null;
    for (const v of variants) {
      if (roomTopics.has(v)) {
        currentTopic = roomTopics.get(v);
        break;
      }
    }
    if (currentTopic) {
      socket.emit('room-topic-sync', { topic: currentTopic });
    }
  });

  // ── Secure Token / Passcode Verification (Instant Access for Authorized Students) ──
  socket.on('verify-room-passcode', async ({ roomId: rawRoomId, passcode, userName, userRole }) => {
    const canonicalRoomId = getCanonicalRoomId(rawRoomId);
    const roomId = canonicalRoomId || sanitizeRoomId(rawRoomId);
    socket.roomId = roomId;

    if (userRole === 'instructor') {
      admittedSockets.add(socket.id);
      let curPasscode = roomPasscodes.get(roomId);
      if (!curPasscode) {
        try {
          const r = await Room.findOne({ roomId }).lean();
          if (r && r.passcode) curPasscode = r.passcode;
        } catch (e) {}
      }
      if (!curPasscode) {
        curPasscode = generatePasscode();
        roomPasscodes.set(roomId, curPasscode);
        try {
          await Room.findOneAndUpdate({ roomId }, { $set: { passcode: curPasscode } });
        } catch (e) {}
      }
      socket.emit('admission-granted', { roomId, passcode: curPasscode });
      return;
    }

    // Check active instructor and session existence
    const variants = getRoomVariants(roomId);
    let activeRoomDoc = null;
    try {
      activeRoomDoc = await Room.findOne({ roomId: { $in: variants } }).lean();
    } catch (e) {}

    let instructorOnline = false;
    for (const v of variants) {
      const instSockets = getInstructorSockets(v);
      if (instSockets && instSockets.length > 0) {
        instructorOnline = true;
        break;
      }
    }

    if (!activeRoomDoc && !instructorOnline) {
      socket.emit('admission-denied', {
        message: 'This meeting does not exist or has not been started by the instructor yet.'
      });
      return;
    }

    if (activeRoomDoc && activeRoomDoc.isActive === false && !instructorOnline) {
      socket.emit('admission-denied', {
        message: 'This meeting session has already ended.'
      });
      return;
    }

    if (!instructorOnline) {
      socket.emit('admission-denied', {
        message: 'The instructor has not started the live class yet. Please wait for the teacher to join.'
      });
      return;
    }

    // Room locked check
    if (lockedRooms.has(roomId)) {
      socket.emit('admission-denied', { message: 'This room has been locked by the instructor.' });
      return;
    }

    // Get room passcode
    let targetPasscode = roomPasscodes.get(roomId);
    if (!targetPasscode) {
      try {
        const r = await Room.findOne({ roomId }).lean();
        if (r && r.passcode) {
          targetPasscode = r.passcode;
          roomPasscodes.set(roomId, targetPasscode);
        }
      } catch (e) {}
    }

    const entered = (passcode || '').trim().toLowerCase();
    const real = (targetPasscode || '').trim().toLowerCase();

    // STRICT PASSCODE MATCH: must have targetPasscode, must have entered passcode, and entered === real
    const isAuthorized = Boolean(targetPasscode && entered && entered === real);

    if (isAuthorized) {
      admittedSockets.add(socket.id);
      socket.emit('admission-granted', { roomId });
      console.log(`✅ Instant Access: Authorized student "${userName || socket.id}" entered room ${roomId}`);
    } else {
      socket.emit('admission-denied', {
        message: 'Invalid class passcode. Unauthorized access denied.'
      });
      console.warn(`🚨 SECURITY ALERT: Unauthorized access attempt in ${roomId} by "${userName}" (${socket.id}) with code: "${passcode}"`);

      // Drop silent security alert to Instructor Dashboard
      const instSockets = getInstructorSockets(roomId);
      instSockets.forEach(sId => {
        io.to(sId).emit('security-alert', {
          type: 'unauthorized_attempt',
          userName: userName || 'Unknown Student',
          socketId: socket.id,
          attemptedPasscode: passcode || '(empty)',
          timestamp: Date.now(),
          message: `Unauthorized access attempt by "${userName || 'Unknown Student'}" was blocked (Invalid Passcode).`
        });
      });
    }
  });

  // ── Student Admission Waiting Room (Security & Real-time Instructor Permission) ──
  socket.on('request-admission', ({ roomId: rawRoomId, userId, userName, userRole, photo }) => {
    const canonicalRoomId = getCanonicalRoomId(rawRoomId);
    const roomId = canonicalRoomId || sanitizeRoomId(rawRoomId);
    socket.roomId = roomId;

    // Instructors bypass the waiting room directly
    if (userRole === 'instructor' || admittedSockets.has(socket.id)) {
      admittedSockets.add(socket.id);
      socket.emit('admission-granted', { roomId });
      return;
    }

    // If room is locked, inform immediately
    if (lockedRooms.has(roomId)) {
      socket.emit('room-locked-error', { message: 'This room has been locked by the instructor.' });
      return;
    }

    if (!pendingAdmissions.has(roomId)) {
      pendingAdmissions.set(roomId, new Map());
    }

    const studentData = {
      socketId: socket.id,
      userId: userId || socket.id,
      userName: (userName || 'Student').trim(),
      userRole: userRole || 'student',
      photo: photo || null,
      timestamp: Date.now()
    };

    pendingAdmissions.get(roomId).set(socket.id, studentData);
    socket.emit('admission-pending', {
      roomId,
      message: 'Waiting for the instructor to admit you...'
    });

    const pendingList = Array.from(pendingAdmissions.get(roomId).values());
    const instSockets = getInstructorSockets(roomId);
    instSockets.forEach(instSocketId => {
      io.to(instSocketId).emit('admission-request', {
        student: studentData,
        pendingList
      });
      io.to(instSocketId).emit('pending-admissions-list', pendingList);
    });

    console.log(`⏳ Student "${studentData.userName}" (${socket.id}) requested admission in room: ${roomId}`);
  });

  socket.on('admit-student', ({ roomId: rawRoomId, targetSocketId }) => {
    const canonicalRoomId = getCanonicalRoomId(rawRoomId);
    const roomId = canonicalRoomId || socket.roomId;
    if (pendingAdmissions.has(roomId)) {
      pendingAdmissions.get(roomId).delete(targetSocketId);
    }
    admittedSockets.add(targetSocketId);
    io.to(targetSocketId).emit('admission-granted', { roomId });

    const pendingList = pendingAdmissions.has(roomId) ? Array.from(pendingAdmissions.get(roomId).values()) : [];
    const instSockets = getInstructorSockets(roomId);
    instSockets.forEach(sId => io.to(sId).emit('pending-admissions-list', pendingList));
    console.log(`✅ Admitted student ${targetSocketId} into room: ${roomId}`);
  });

  socket.on('deny-student', ({ roomId: rawRoomId, targetSocketId }) => {
    const canonicalRoomId = getCanonicalRoomId(rawRoomId);
    const roomId = canonicalRoomId || socket.roomId;
    if (pendingAdmissions.has(roomId)) {
      pendingAdmissions.get(roomId).delete(targetSocketId);
    }
    io.to(targetSocketId).emit('admission-denied', {
      message: 'The instructor did not allow you to enter this class.'
    });

    const pendingList = pendingAdmissions.has(roomId) ? Array.from(pendingAdmissions.get(roomId).values()) : [];
    const instSockets = getInstructorSockets(roomId);
    instSockets.forEach(sId => io.to(sId).emit('pending-admissions-list', pendingList));
    console.log(`❌ Denied admission for student ${targetSocketId} in room: ${roomId}`);
  });

  socket.on('admit-all-students', ({ roomId: rawRoomId }) => {
    const canonicalRoomId = getCanonicalRoomId(rawRoomId);
    const roomId = canonicalRoomId || socket.roomId;
    if (pendingAdmissions.has(roomId)) {
      const pendingMap = pendingAdmissions.get(roomId);
      for (const [sId] of pendingMap.entries()) {
        admittedSockets.add(sId);
        io.to(sId).emit('admission-granted', { roomId });
      }
      pendingMap.clear();
    }
    const instSockets = getInstructorSockets(roomId);
    instSockets.forEach(sId => io.to(sId).emit('pending-admissions-list', []));
    console.log(`✅ Admitted all pending students in room: ${roomId}`);
  });

  socket.on('get-pending-admissions', ({ roomId: rawRoomId }) => {
    const canonicalRoomId = getCanonicalRoomId(rawRoomId);
    const roomId = canonicalRoomId || socket.roomId;
    const pendingList = pendingAdmissions.has(roomId) ? Array.from(pendingAdmissions.get(roomId).values()) : [];
    socket.emit('pending-admissions-list', pendingList);
  });

  // ── Host Controls: Mute All ──
  socket.on('host-mute-all', ({ roomId: rawRoomId, isMuted }) => {
    const canonicalRoomId = getCanonicalRoomId(rawRoomId || socket.roomId);
    const roomId = canonicalRoomId || sanitizeRoomId(rawRoomId || socket.roomId);
    console.log(`🔇 Host ${isMuted === false ? 'unmuted' : 'muted'} all in room: ${roomId}`);
    if (roomId) {
      if (isMuted === false) {
        socket.to(roomId).emit('host-unmute-all');
      } else {
        socket.to(roomId).emit('force-mute', { byHost: true, lock: true });
      }
    }
  });

  // ── Host Controls: Individual Student Mute / Unmute ──
  socket.on('host-mute-student', ({ roomId: rawRoomId, targetSocketId, isMuted = true }) => {
    console.log(`🔇 Host ${isMuted ? 'muted' : 'unmuted'} student ${targetSocketId}`);
    if (targetSocketId) {
      if (isMuted) {
        io.to(targetSocketId).emit('force-mute', { byHost: true, lock: true });
      } else {
        io.to(targetSocketId).emit('host-unmute-student');
      }
    }
  });

  // ── Host Controls: Individual Student Camera Toggle ──
  socket.on('host-toggle-student-camera', ({ roomId, targetSocketId, action }) => {
    console.log(`📹 Host requested camera ${action} for student ${targetSocketId} in ${roomId}`);
    io.to(targetSocketId).emit('force-toggle-camera', { action });
  });

  // ── Participant Media State Update Broadcast ──
  socket.on('media-state-change', ({ roomId: rawRoomId, videoOn, micOn }) => {
    const canonicalRoomId = getCanonicalRoomId(rawRoomId || socket.roomId);
    const roomId = canonicalRoomId || sanitizeRoomId(rawRoomId || socket.roomId);
    const variants = getRoomVariants(rawRoomId || socket.roomId);
    if (roomId) {
      variants.forEach(v => {
        if (!roomMediaStates.has(v)) {
          roomMediaStates.set(v, new Map());
        }
        roomMediaStates.get(v).set(socket.id, {
          videoOn: videoOn !== false,
          micOn: micOn !== false
        });
      });
    }
    const payload = {
      socketId: socket.id,
      videoOn: videoOn !== false,
      micOn: micOn !== false
    };
    variants.forEach(v => socket.to(v).emit('peer-media-state-change', payload));
  });

  // ── Query Room Info (Host & Title) ──
  socket.on('get-room-info', async ({ roomId: rawRoomId }, callback) => {
    const roomId = sanitizeRoomId(rawRoomId);
    let instName = roomInstructors.get(roomId);
    if (!instName && roomId) {
      try {
        const alt = roomId.replace(/-/g, '');
        const r = await Room.findOne({ $or: [{ roomId }, { roomId: alt }] }).lean();
        if (r && r.instructorName) {
          instName = r.instructorName;
          roomInstructors.set(roomId, instName);
        }
      } catch (e) {}
    }
    if (typeof callback === 'function') {
      callback({ instructorName: instName || 'Instructor' });
    } else {
      socket.emit('room-info-response', { roomId, instructorName: instName || 'Instructor' });
    }
  });

  // ── Host Controls: Lock / Unlock Room ──
  socket.on('host-toggle-lock', ({ roomId, isLocked }) => {
    if (isLocked) {
      lockedRooms.add(roomId);
    } else {
      lockedRooms.delete(roomId);
    }
    console.log(`🔒 Room ${roomId} lock status: ${isLocked}`);
    io.to(roomId).emit('room-lock-status', { isLocked });
  });

  // ── Host Controls: Remove Participant ──
  socket.on('host-remove-peer', ({ roomId, targetSocketId }) => {
    console.log(`🚫 Host removed participant ${targetSocketId} from ${roomId}`);
    io.to(targetSocketId).emit('force-removed', { reason: 'You have been removed from the session by the host.' });
  });

  // ── Live Lecture Transcription Broadcast ── 
  // Supports both current and legacy frontend event names.

  const broadcastTranscription = (data = {}) => {
    try {
      // Get the classroom ID from the event or connected socket.
      const rawRoomId = data?.roomId || socket.roomId;

      // Normalize the room ID to match the joined classroom.
      const targetRoom =
        getCanonicalRoomId(rawRoomId) ||
        sanitizeRoomId(rawRoomId);

      // Validate the caption.
      const entry = data?.entry;

      if (
        !targetRoom ||
        !entry ||
        typeof entry.text !== 'string' ||
        !entry.text.trim()
      ) {
        console.warn('⚠️ Invalid transcription data received.');
        return;
      }

      // Prepare caption payload.
      const payload = {
        ...data,
        roomId: targetRoom,
        entry: {
          ...entry,
          text: entry.text.trim()
        }
      };

      // Broadcast caption to all other participants in this classroom.
      socket.to(targetRoom).emit('receive-transcription', payload);

      console.log(
        `📝 Live caption broadcast successfully in room: ${targetRoom}`
      );

    } catch (error) {
      console.error(
        '❌ Live transcription broadcast error:',
        error.message
      );
    }
  };

  // Current frontend event.
  socket.on('send-transcription', broadcastTranscription);

  // Legacy event support.
  socket.on('new-transcription', broadcastTranscription);




  // ── Host Controls: Lock / Unlock Student Chat ──
  socket.on('toggle-chat-lock', ({ roomId: rawRoomId, isLocked }) => {
    const canonicalRoomId = getCanonicalRoomId(rawRoomId) || sanitizeRoomId(rawRoomId);
    const variants = getRoomVariants(rawRoomId);
    if (isLocked) {
      variants.forEach(v => roomLockedChats.add(v));
    } else {
      variants.forEach(v => roomLockedChats.delete(v));
    }
    console.log(`💬 Chat lock status in ${canonicalRoomId}: ${isLocked}`);
    variants.forEach(v => io.to(v).emit('chat-lock-status', { isLocked: Boolean(isLocked) }));
  });

  // ── Host Controls: Toggle Student Whiteboard Drawing ──
  socket.on('toggle-whiteboard-student-draw', ({ roomId: rawRoomId, allowed }) => {
    const canonicalRoomId = getCanonicalRoomId(rawRoomId) || sanitizeRoomId(rawRoomId);
    const variants = getRoomVariants(rawRoomId);
    if (allowed) {
      variants.forEach(v => roomStudentDrawingAllowed.add(v));
    } else {
      variants.forEach(v => roomStudentDrawingAllowed.delete(v));
    }
    console.log(`🎨 Student drawing permission in ${canonicalRoomId}: ${allowed}`);
    variants.forEach(v => io.to(v).emit('whiteboard-student-draw-status', { allowed: Boolean(allowed) }));
  });

  // ── Live Chat ──
  socket.on('send-message', (data) => {
    const rawTarget = data?.roomId || socket.roomId;
    const targetRoom = getCanonicalRoomId(rawTarget) || sanitizeRoomId(rawTarget);
    if (!targetRoom) return;

    // Check if chat is locked for students
    if (data.senderRole !== 'instructor' && (roomLockedChats.has(targetRoom) || roomLockedChats.has(rawTarget))) {
      socket.emit('chat-error', { message: 'Chat has been locked by the teacher.' });
      return;
    }
    const msgPayload = {
      id: data.id || ('msg_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6)),
      roomId: targetRoom,
      message: data.message,
      senderId: data.senderId || socket.id,
      senderName: data.senderName,
      senderRole: data.senderRole || 'student',
      isDoubt: !!data.isDoubt,
      doubtId: data.doubtId || null,
      videoTimestamp: typeof data.videoTimestamp === 'number' ? data.videoTimestamp : null,
      videoTimeFormatted: data.videoTimeFormatted || null,
      isResolvedNotice: !!data.isResolvedNotice,
      resolvedDoubtId: data.resolvedDoubtId || null,
      file: data.file || null,
      time: data.time || new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    };
    // Emit exactly once to the target room
    io.to(targetRoom).emit('receive-message', msgPayload);
  });

  // ── Pinned Doubts System ──
  socket.on('pin-doubt', (data) => {
    const rawTarget = data?.roomId || socket.roomId;
    const targetRoom = getCanonicalRoomId(rawTarget) || sanitizeRoomId(rawTarget);
    console.log(`📌 [pin-doubt] Received in room "${targetRoom}":`, data?.doubt?.text);
    if (targetRoom) {
      io.to(targetRoom).emit('doubt-pinned', data.doubt);
    }
  });

  socket.on('resolve-doubt', (data) => {
    const rawTarget = data?.roomId || socket.roomId;
    const targetRoom = getCanonicalRoomId(rawTarget) || sanitizeRoomId(rawTarget);
    console.log(`✅ [resolve-doubt] Received in room "${targetRoom}" for doubt:`, data?.doubtId);
    if (targetRoom) {
      io.to(targetRoom).emit('doubt-resolved', { doubtId: data.doubtId });
    }
  });

  socket.on('seek-to-video-time', (data) => {
    const rawTarget = data?.roomId || socket.roomId;
    const targetRoom = getCanonicalRoomId(rawTarget) || sanitizeRoomId(rawTarget);
    if (targetRoom) {
      io.to(targetRoom).emit('seek-to-video-time', data);
    }
  });

  // ── Student Attention & Engagement Telemetry ──
  socket.on('student-engagement-update', (data) => {
    socket.to(data.roomId).emit('peer-engagement-stat', {
      socketId: socket.id,
      studentName: data.studentName,
      score: data.score,
      isFocused: data.isFocused,
    });
  });

  // ── Hand Raise Queue ──
  socket.on('raise-hand', (data) => {
    const canonicalRoomId = getCanonicalRoomId(data?.roomId || socket.roomId);
    const roomId = canonicalRoomId || sanitizeRoomId(data?.roomId || socket.roomId);
    if (roomId) {
      io.to(roomId).emit('student-hand-raised', {
        socketId: socket.id,
        userId: data?.userId || socket.id,
        studentName: data?.studentName || 'Student',
        time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      });
    }
  });

  socket.on('lower-hand', (data) => {
    const canonicalRoomId = getCanonicalRoomId(data?.roomId || socket.roomId);
    const roomId = canonicalRoomId || sanitizeRoomId(data?.roomId || socket.roomId);
    if (roomId) {
      io.to(roomId).emit('student-hand-lowered', {
        socketId: data?.socketId || socket.id,
        userId: data?.userId,
      });
    }
  });

  // ── Category 3: Session Recording Broadcast ──
  socket.on('recording-status-change', (data) => {
    socket.to(data.roomId).emit('recording-status-change', {
      isRecording: data.isRecording,
      recordedByName: data.recordedByName
    });
  });

  // ── Whiteboard: Pen / Eraser strokes ──
  socket.on('draw-stroke', (data) => {
    const targetRoom = sanitizeRoomId(data?.roomId) || socket.roomId;
    socket.to(targetRoom).emit('draw-stroke', data);
  });

  // ── Whiteboard: Shape tools (line / rect) ──
  socket.on('draw-shape', (data) => {
    const targetRoom = sanitizeRoomId(data?.roomId) || socket.roomId;
    socket.to(targetRoom).emit('draw-shape', data);
  });

  // ── Whiteboard: Clear canvas ──
  socket.on('clear-canvas', (data) => {
    const targetRoom = sanitizeRoomId(data?.roomId) || socket.roomId;
    socket.to(targetRoom).emit('clear-canvas');
  });

  // ── Whiteboard: Laser Pointer Sync ──
  socket.on('whiteboard-laser', (data) => {
    const targetRoom = sanitizeRoomId(data?.roomId) || socket.roomId;
    socket.to(targetRoom).emit('whiteboard-laser', data);
  });

  // ── Whiteboard: Undo / Redo Snapshot Restore ──
  socket.on('whiteboard-restore-snapshot', (data) => {
    const targetRoom = sanitizeRoomId(data?.roomId) || socket.roomId;
    socket.to(targetRoom).emit('whiteboard-restore-snapshot', data);
  });

  // ── Whiteboard: Live Typed Notes Sync ──
  socket.on('whiteboard-typing-sync', (data) => {
    const targetRoom = sanitizeRoomId(data?.roomId) || socket.roomId;
    socket.to(targetRoom).emit('whiteboard-typing-sync', data);
  });

  // ── Whiteboard: Initial Canvas Sync for newly joined students ──
  socket.on('request-canvas-state', (data) => {
    const targetRoom = sanitizeRoomId(data?.roomId) || socket.roomId;
    socket.to(targetRoom).emit('send-canvas-state', { targetSocketId: socket.id });
  });

  socket.on('canvas-state-response', (data) => {
    if (data?.targetSocketId) {
      io.to(data.targetSocketId).emit('whiteboard-restore-snapshot', {
        snapshot: data.snapshot,
        notes: data.notes,
        fontSize: data.fontSize,
        textColor: data.textColor
      });
    }
  });

  // ── Synchronized Video Player & YouTube Collaboration ──
  socket.on('video-state-change', (data) => {
    const targetRoom = sanitizeRoomId(data?.roomId) || socket.roomId;
    if (targetRoom) {
      if (roomVideoStates.has(targetRoom)) {
        const current = roomVideoStates.get(targetRoom);
        current.isPlaying = data.type === 'play';
        if (typeof data.timestamp === 'number') current.currentTime = data.timestamp;
      }
      socket.to(targetRoom).emit('video-state-change', data);
      const altRoom = targetRoom.replace(/-/g, '');
      if (altRoom && altRoom !== targetRoom) {
        socket.to(altRoom).emit('video-state-change', data);
      }
    }
  });

  socket.on('video-source-change', (data) => {
    const targetRoom = sanitizeRoomId(data?.roomId) || socket.roomId;
    if (targetRoom) {
      roomVideoStates.set(targetRoom, {
        mediaType: data.mediaType,
        ytVideoId: data.ytVideoId || '',
        videoSrc: data.videoSrc || '',
        videoTitle: data.videoTitle || 'Lecture Video',
        currentTime: 0,
        isPlaying: false,
        instructorName: data.instructorName || 'Instructor'
      });
      // Broadcast to all other peers in the room
      socket.to(targetRoom).emit('video-source-change', data);
      const altRoom = targetRoom.replace(/-/g, '');
      if (altRoom && altRoom !== targetRoom) {
        socket.to(altRoom).emit('video-source-change', data);
      }
    }
  });

  // ── Real-time Workspace View Sync (Instructor switches to Video, Whiteboard, or Cameras) ──
  socket.on('workspace-view-sync', (data) => {
    const targetRoom = sanitizeRoomId(data?.roomId) || socket.roomId;
    if (targetRoom && data?.view) {
      roomWorkspaceViews.set(targetRoom, data.view);
      socket.to(targetRoom).emit('workspace-view-sync', data);
      const altRoom = targetRoom.replace(/-/g, '');
      if (altRoom && altRoom !== targetRoom) {
        socket.to(altRoom).emit('workspace-view-sync', data);
      }
    }
  });

  // ── Request current Video & Workspace state for newly joined users ──
  socket.on('request-video-state', (data) => {
    const targetRoom = sanitizeRoomId(data?.roomId) || socket.roomId;
    if (targetRoom && roomVideoStates.has(targetRoom)) {
      socket.emit('video-source-change', roomVideoStates.get(targetRoom));
    }
  });

  // ── 3D Model Viewer Sync (Rotation + Zoom) ──
  socket.on('model-rotate', (data) => {
    socket.to(data.roomId).emit('model-rotate', data);
  });

  // ── Timeline Annotation Pins ──
  socket.on('pin-annotation', (data) => {
    socket.to(data.roomId).emit('pin-annotation', data);
  });

  // ── Classroom Topic Sync ──
  socket.on('set-room-topic', ({ roomId: rawRoomId, topic }) => {
    const variants = getRoomVariants(rawRoomId || socket.roomId);
    if (variants.length > 0 && topic && typeof topic === 'string') {
      const cleanT = topic.trim();
      variants.forEach(v => {
        roomTopics.set(v, cleanT);
        io.to(v).emit('room-topic-sync', { topic: cleanT });
      });
      console.log(`📚 Topic updated to "${cleanT}" in room variants:`, variants);
    }
  });

  socket.on('set-room-passcode', async ({ roomId: rawRoomId, passcode }) => {
    const canonicalRoomId = getCanonicalRoomId(rawRoomId || socket.roomId);
    const roomId = canonicalRoomId || sanitizeRoomId(rawRoomId || socket.roomId);
    const variants = getRoomVariants(roomId);
    if (roomId && passcode) {
      const cleanP = String(passcode).trim();
      variants.forEach(v => roomPasscodes.set(v, cleanP));
      try {
        await Room.findOneAndUpdate({ roomId }, { $set: { passcode: cleanP } });
      } catch (e) {}
      io.to(roomId).emit('room-passcode', { passcode: cleanP });
      console.log(`🔐 Passcode updated to "${cleanP}" in room: ${roomId}`);
    }
  });

  // ── AI Lecture Quiz Sync & Live Leaderboard ──
  socket.on('publish-quiz', (data) => {
    const variants = getRoomVariants(data?.roomId || socket.roomId);
    if (variants.length > 0 && data?.quiz) {
      variants.forEach(v => {
        roomActiveQuizzes.set(v, data.quiz);
        if (data.quiz.topic) roomTopics.set(v, data.quiz.topic.trim());
        io.to(v).emit('room-quiz-published', data.quiz);
      });
      console.log(`📝 Quiz on topic "${data.quiz.topic || data.quiz.title}" (${data.quiz.questions?.length || 0} questions) published to variants:`, variants);
    }
  });

  socket.on('submit-quiz-score', (data) => {
    const variants = getRoomVariants(data?.roomId || socket.roomId);
    if (variants.length > 0) {
      variants.forEach(v => {
        io.to(v).emit('student-score-submitted', data);
      });
      console.log(`🏅 Score submitted by ${data.studentName || 'Student'} in ${variants[0]}: ${data.score}/${data.total}`);
    }
  });

  socket.on('request-active-quiz', (data) => {
    const variants = getRoomVariants(data?.roomId || socket.roomId);
    let foundQuiz = null;
    for (const v of variants) {
      if (roomActiveQuizzes.has(v)) {
        foundQuiz = roomActiveQuizzes.get(v);
        break;
      }
    }
    if (foundQuiz) {
      socket.emit('room-quiz-published', foundQuiz);
    }
  });

  // ── WebRTC Signaling ──
  socket.on('webrtc-peer-state', (data) => {
    console.log(`📡 [WebRTC State] from ${socket.id} (${socket.roomId || 'no-room'}):`, data);
  });

  socket.on('webrtc-peer-error', (data) => {
    console.warn(`🚨 [WebRTC Error] from ${socket.id} (${socket.roomId || 'no-room'}):`, data);
  });

  socket.on('sending-signal', (payload) => {
    console.log(`📡 Signal (Offer) from ${payload.callerID} to ${payload.userToSignal}`);
    io.to(payload.userToSignal).emit('user-joined', {
      signal: payload.signal,
      callerID: payload.callerID,
    });
  });

  socket.on('returning-signal', (payload) => {
    console.log(`📡 Signal (Answer) from ${socket.id} to ${payload.callerID}`);
    io.to(payload.callerID).emit('receiving-returned-signal', {
      signal: payload.signal,
      id: socket.id,
    });
  });

  // ── End Meeting for All (Instructor Broadcast) ──
  socket.on('end-meeting-for-all', ({ roomId: rawRoomId }) => {
    const roomId = sanitizeRoomId(rawRoomId || socket.roomId);
    if (!roomId) return;
    console.log(`🛑 Meeting ended for all by instructor in room: ${roomId}`);
    io.to(roomId).emit('meeting-ended-by-host', {
      message: 'The instructor has ended the classroom session for all attendees.'
    });
    // Mark room as inactive in MongoDB
    Room.findOneAndUpdate(
      { roomId },
      { $set: { isActive: false, endedAt: new Date() } }
    ).catch(() => {});
  });

  // ── Disconnect: notify room peers and update roster ──
  socket.on('disconnect', () => {
    console.log('❌ User Disconnected:', socket.id);
    if (socket.roomId) {
      const canonicalRoomId = getCanonicalRoomId(socket.roomId) || sanitizeRoomId(socket.roomId);
      
      // Notify peers once in the canonical room
      socket.to(canonicalRoomId).emit('user-disconnected', socket.id);

      // Clean up from pending waiting room if user was waiting
      if (pendingAdmissions.has(canonicalRoomId)) {
        const pMap = pendingAdmissions.get(canonicalRoomId);
        if (pMap.has(socket.id)) {
          pMap.delete(socket.id);
          const pendingList = Array.from(pMap.values());
          const instSockets = getInstructorSockets(canonicalRoomId);
          instSockets.forEach(sId => io.to(sId).emit('pending-admissions-list', pendingList));
        }
      }
      admittedSockets.delete(socket.id);

      if (roomUsers.has(canonicalRoomId)) {
        const currentRoomMap = roomUsers.get(canonicalRoomId);
        currentRoomMap.delete(socket.id);
        const remainingCount = currentRoomMap.size;

        if (remainingCount === 0) {
          roomUsers.delete(canonicalRoomId);
          lockedRooms.delete(canonicalRoomId);
          roomMediaStates.delete(canonicalRoomId);
          pendingAdmissions.delete(canonicalRoomId);
        } else {
          const participantList = Array.from(currentRoomMap.values());
          io.to(canonicalRoomId).emit('room-participants-update', participantList);
        }

        if (roomMediaStates.has(canonicalRoomId)) {
          roomMediaStates.get(canonicalRoomId).delete(socket.id);
        }

        // Update MongoDB document: mark leftAt timestamp while preserving their attendance record
        Room.findOneAndUpdate(
          { roomId: canonicalRoomId },
          {
            $set: {
              studentsCount: remainingCount,
              isActive: remainingCount > 0,
              ...(remainingCount === 0 ? { endedAt: new Date() } : {})
            }
          }
        ).catch(() => {});
      }
    }
  });
};

module.exports = syncHandler;
