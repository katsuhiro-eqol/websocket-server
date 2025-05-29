const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
require('dotenv').config();

const app = express();
const httpServer = createServer(app);

// CORSの設定
app.use(cors({
  origin: [process.env.CLIENT_URL, process.env.FEATURE_URL, "http://localhost:3000"],
  methods: ["GET", "POST"],
  credentials: true
}));

// Socket.IOの設定
const io = new Server(httpServer, {
  cors: {
    origin:  [process.env.CLIENT_URL, process.env.FEATURE_URL, "http://localhost:3000"],
    methods: ["GET", "POST"],
    credentials: true
  }
});

// データ管理
const connectedUsers = new Map(); // socketId -> userInfo
const chatRooms = new Map();      // roomId -> roomInfo
//const adminUsers = new Set(['Global', 'TargetEntertainment', 'Global_event5']); // 管理者ID

// Socket.IOのイベントハンドラ
io.on('connection', (socket) => {
  // ユーザー登録
  socket.on('register', (userData) => {
    const userInfo = {
      ...userData,
      socketId: socket.id,
      joinedAt: Date.now(),
      //isAdmin: adminUsers.has(userData.userId)
    };
    console.log(userInfo)
    
    connectedUsers.set(socket.id, userInfo);
    
    if (userInfo.isAdmin) {
        if (userInfo.userId){
            socket.join(`admins_${userInfo.userId}`);
        }
        console.log(chatRooms)
      const waitingRooms = Array.from(chatRooms.values())
        .filter(room => room.userId === userInfo.userId && room.status === 'waiting');
        console.log("waitingRooms", waitingRooms)
      socket.emit('waitingChatRooms', waitingRooms);
    }
    
    console.log(`${userInfo.isAdmin ? 'Admin' : 'User'} registered:`, userData.username);
  });

  socket.on('startSupportChat', (data) => {
    const user = connectedUsers.get(socket.id)
    if (!user || user.isAdmin) return
    console.log("user", user)

    const roomId = `support_${socket.id}_${Date.now()}`
    const chatRoom = {
      id: roomId,
      socketId: socket.id,
      userId: user.userId,
      username: user.username,
      adminId: null,
      adminName: null,
      status: 'waiting', // waiting, active, closed
      createdAt: Date.now(),
      messages: [{
        id: Date.now().toString(),
        text: data.initialMessage || 'サポートが必要です',
        senderId: socket.id,
        senderName: user.username,
        timestamp: Date.now(),
        type: 'user'
      }]
    }

    chatRooms.set(roomId, chatRoom)
    console.log(chatRooms)
    socket.join(roomId)

    // ユーザーにルーム作成を通知
    socket.emit('chatRoomCreated', {
      roomId,
      message: 'スタッフにメッセージを送信しました。応答をお待ちください。'
    })

    // 全管理者に新しいサポート要求を通知
    //socket.to("admins").emit('newSupportRequest', chatRoom)
    //userId(eventId)が一致するadminに通知
    if (user.userId){
        socket.to(`admins_${user.userId}`).emit('newSupportRequest', chatRoom)
    }
  })

  // 管理者がサポートチャットに参加
  socket.on('joinSupportChat', (data) => {
    const admin = connectedUsers.get(socket.id)
    if (!admin || !admin.isAdmin) return

    const { roomId } = data
    const chatRoom = chatRooms.get(roomId)
    
    if (!chatRoom || chatRoom.status !== 'waiting') {
      socket.emit('error', { message: 'チャットルームが見つからないか、既に対応中です' })
      return
    }

    // チャットルームを更新
    chatRoom.adminId = socket.id
    chatRoom.adminName = admin.username
    chatRoom.status = 'active'
    chatRooms.set(roomId, chatRoom)

    // 管理者をルームに参加させる
    socket.join(roomId)

    // ユーザーに管理者参加を通知
    io.to(roomId).emit('adminJoined', {
      adminName: admin.username,
      message: `${admin.username}が対応を開始しました`
    })

    // 既存のメッセージを管理者に送信
    socket.emit('chatHistory', chatRoom.messages)

    // 他の管理者に取得済みを通知
    socket.to('admins').emit('supportTaken', { roomId, adminName: admin.username })
  })

  // チャットメッセージ送信
  socket.on('sendChatMessage', (data) => {
    const { roomId, text } = data
    const user = connectedUsers.get(socket.id)
    const chatRoom = chatRooms.get(roomId)

    if (!user || !chatRoom) return

    // ユーザーがこのルームのメンバーかチェック
    if (chatRoom.userId !== socket.id && chatRoom.adminId !== socket.id) {
      socket.emit('error', { message: '権限がありません' })
      return
    }

    const message = {
      id: Date.now().toString(),
      text,
      senderId: socket.id,
      senderName: user.username,
      timestamp: Date.now(),
      type: user.isAdmin ? 'admin' : 'user'
    }

    // メッセージを保存
    chatRoom.messages.push(message)
    chatRooms.set(roomId, chatRoom)

    // ルーム内の全員にメッセージ送信
    io.to(roomId).emit('newChatMessage', message)
  })

  // チャット終了
  socket.on('closeSupportChat', (data) => {
    const { roomId } = data
    const user = connectedUsers.get(socket.id)
    const chatRoom = chatRooms.get(roomId)

    if (!user || !chatRoom) return

    // 権限チェック（管理者またはチャットの当事者）
    if (!user.isAdmin && chatRoom.userId !== socket.id) return

    chatRoom.status = 'closed'
    chatRoom.closedAt = Date.now()
    chatRoom.closedBy = socket.id
    chatRooms.set(roomId, chatRoom)

    // ルーム内の全員に終了を通知
    io.to(roomId).emit('chatClosed', {
      message: `チャットが${user.username}によって終了されました`,
      closedBy: user.username
    })
  })

  // 管理者が待機中のチャット一覧を要求
  socket.on('getWaitingChats', () => {
    const user = connectedUsers.get(socket.id)
    if (!user || !user.isAdmin) return

    const waitingRooms = Array.from(chatRooms.values())
      .filter(room => room.status === 'waiting')
    socket.emit('waitingChatRooms', waitingRooms)
  })

  // 切断処理
  socket.on('disconnect', () => {
    const user = connectedUsers.get(socket.id)
    if (user) {
      connectedUsers.delete(socket.id)
      
      // アクティブなチャットがある場合の処理
      const activeChat = Array.from(chatRooms.values())
        .find(room => (room.userId === socket.id || room.adminId === socket.id) && room.status === 'active')
      
      if (activeChat) {
        if (user.isAdmin) {
          // 管理者が切断した場合
          activeChat.status = 'waiting'
          activeChat.adminId = null
          activeChat.adminName = null
          io.to(activeChat.id).emit('adminDisconnected', {
            message: '管理者が切断されました。別の管理者をお待ちください。'
          })
          // 他の管理者に再度通知
          socket.to('admins').emit('newSupportRequest', activeChat)
        } else {
          // ユーザーが切断した場合
          activeChat.status = 'closed'
          io.to(activeChat.id).emit('userDisconnected', {
            message: 'ユーザーが切断されました。'
          })
        }
        chatRooms.set(activeChat.id, activeChat)
      }
    }
    console.log('User disconnected:', socket.id)
  })
});

// サーバーの起動
const PORT = process.env.PORT || 3001;
httpServer.listen(PORT, () => {
  console.log(`WebSocket server running on port ${PORT}`);
});