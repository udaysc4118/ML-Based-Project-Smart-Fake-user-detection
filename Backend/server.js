require('dotenv').config();

const express = require('express');
const path = require('path');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const readline = require('readline');
const { createClient } = require('@supabase/supabase-js');
const nodemailer = require('nodemailer');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'Frontend')));

const supabaseUrl = process.env.SUPABASE_URL || '';
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY || '';
const hasSupabase = Boolean(supabaseUrl && supabaseAnonKey);

const supabase = hasSupabase
  ? createClient(supabaseUrl, supabaseAnonKey, {
      auth: {
        persistSession: false,
        autoRefreshToken: false
      }
    })
  : null;

const pendingRequests = new Map();
const otpCooldowns = new Map();
// pendingRequests[email] = { action: 'signup'|'reset', username, passwordHash, verified, code }

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS
  }
});

// Verify transporter configuration at startup so mail issues are visible early
transporter.verify().then(() => {
  console.log('Email transporter configured and ready');
}).catch((err) => {
  console.error('Email transporter verification failed:', err && err.message ? err.message : err);
});

const fallbackUsers = [
  { email: 'user@example.com', passwordHash: bcrypt.hashSync('user123', 10), role: 'user', username: 'demoUser' }
];

let server;

function shutdownServer(reason) {
  if (reason) {
    console.log(reason);
  }

  if (server) {
    server.close(() => process.exit(0));
    return;
  }

  process.exit(0);
}

function enableTerminalStopCommand() {
  if (!process.stdin.isTTY) {
    return;
  }

  const terminalInput = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  terminalInput.on('line', (line) => {
    const command = line.trim().toLowerCase();

    if (command === 'stop' || command === 'exit' || command === 'quit') {
      terminalInput.close();
      shutdownServer('Stop command received. Shutting down backend...');
    }
  });

  process.on('SIGINT', () => {
    terminalInput.close();
    shutdownServer('SIGINT received. Shutting down backend...');
  });

  process.on('SIGTERM', () => {
    terminalInput.close();
    shutdownServer('SIGTERM received. Shutting down backend...');
  });
}

function db(table) {
  if (!supabase) {
    throw new Error('Supabase is not configured');
  }

  return supabase.from(table);
}

async function getUserByEmail(email) {
  if (supabase) {
    const { data, error } = await db('app_users')
      .select('id,email,username,password_hash,role')
      .eq('email', email)
      .maybeSingle();

    if (error) throw error;
    return data || null;
  }

  return fallbackUsers.find((user) => user.email === email) || null;
}

app.get('/api/health', (_req, res) => {
  res.json({
    success: true,
    supabase: hasSupabase,
    timestamp: new Date().toISOString()
  });
});

app.post('/api/login', async (req, res) => {
  try {
    const { email, password, loginType } = req.body || {};

    console.log('Login attempt:', { email, loginType });

    if (!email || !password) {
      return res.status(400).json({ success: false, message: 'Missing credentials' });
    }

    if (loginType === 'admin') {
      if (email === 'admin' && password === 'admin123') {
        console.log('Admin login successful');
        return res.json({ success: true, role: 'admin' });
      }

      console.log('Admin login failed for', email);
      return res.status(401).json({ success: false, message: 'Invalid admin credentials' });
    }

    const found = await getUserByEmail(email);
    if (found) {
      const passwordHash = found.password_hash || found.passwordHash;
      const matches = passwordHash && await bcrypt.compare(password, passwordHash);

      if (matches) {
        console.log('User login successful:', email);
        return res.json({ success: true, role: found.role || 'user', username: found.username });
      }
    }

    console.log('User login failed (invalid credentials):', email);
    return res.status(401).json({ success: false, message: 'Invalid user credentials' });
  } catch (err) {
    console.error('Error in /api/login:', err && err.message ? err.message : err);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

app.post('/api/forgot', async (req, res) => {
  let { email, username, newPassword } = req.body || {};
  email = (email || '').toString().trim().toLowerCase();

  if (!email) {
    return res.status(400).json({ success: false, message: 'Email is required' });
  }

  const action = newPassword ? 'signup' : 'reset';
  const passwordHash = newPassword ? await bcrypt.hash(newPassword, 10) : null;
  const cooldownKey = `${email}:${action}`;
  const now = Date.now();
  const cooldownEntry = otpCooldowns.get(cooldownKey);

  if (cooldownEntry && now < cooldownEntry.until) {
    console.log('Duplicate OTP request ignored for', email, 'within cooldown window');
    return res.json({ success: true, duplicate: true, message: 'OTP already sent recently' });
  }

  const code = Math.floor(100000 + Math.random() * 900000).toString();
  otpCooldowns.set(cooldownKey, { until: now + 30000 });

  // Store pending request in memory first
  pendingRequests.set(email, {
    action,
    username: username || email,
    passwordHash,
    verified: false,
    code
  });

  // Persist to DB if available
  if (supabase) {
    const { error } = await db('otp_requests').upsert({
      email,
      code,
      username: username || email,
      password_hash: passwordHash,
      action,
      verified: false
    });

    if (error) {
      pendingRequests.delete(email);
      return res.status(400).json({ success: false, message: error.message });
    }
  }

  // Send Email with Nodemailer (if configured)
  if (process.env.EMAIL_USER && process.env.EMAIL_PASS) {
    try {
      const mailOptions = {
        from: `"RecomAI Support" <${process.env.EMAIL_USER}>`,
        to: email,
        subject: action === 'signup' ? 'Welcome to RecomAI - Verify Your Email' : 'RecomAI - Password Reset OTP',
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e0e0e0; border-radius: 10px;">
            <h2 style="color: #6c5ce7; teThankxt-align: center;">RecomAI</h2>
            <p style="font-size: 16px; color: #333;">Hello ${username || ''},</p>
            <p style="font-size: 16px; color: #333;">
              ${action === 'signup' 
                ? ' Thank you for signing up! Please use the OTP below to verify your email address.' 
                : 'We received a request to reset your password. Use the OTP below to proceed.'}
            </p>
            <div style="text-align: center; margin: 30px 0;">
              <span style="display: inline-block; font-size: 24px; font-weight: bold; background: #f1f3f8; padding: 15px 25px; border-radius: 8px; letter-spacing: 5px; color: #172033;">
                ${code}
              </span>
            </div>
            <p style="font-size: 14px; color: #777; text-align: center;">This code will expire in 10 minutes.</p>
            <hr style="border: none; border-top: 1px solid #eee; margin: 20px 0;" />
            <p style="font-size: 12px; color: #999; text-align: center;">If you didn't request this, please ignore this email.</p>
          </div>
        `
      };

      const info = await transporter.sendMail(mailOptions);
      console.log('Email sent successfully to', email, 'messageId:', info && info.messageId ? info.messageId : info);
    } catch (mailErr) {
      // Remove pending request if we couldn't send the OTP email
      console.error('Error sending email to', email, mailErr && mailErr.message ? mailErr.message : mailErr);
      otpCooldowns.delete(cooldownKey);
      pendingRequests.delete(email);
      if (supabase) {
        await db('otp_requests').delete().eq('email', email);
      }
      return res.status(500).json({ success: false, message: 'Failed to send verification email' });
    }
  } else {
    console.warn('Email credentials not configured; skipping sendMail for', email);
  }

  console.log('OTP generated for', email, code);

  return res.json({ success: true });
});

app.post('/api/verify-otp', async (req, res) => {
  const { email, code } = req.body || {};

  if (!email || !code) {
    return res.status(400).json({ success: false, message: 'Email and code are required' });
  }

  const pending = pendingRequests.get(email);
  if (!pending) {
    return res.status(400).json({ success: false, message: 'No pending request found' });
  }

  if (pending.code !== code) {
    return res.status(400).json({ success: false, message: 'Invalid code' });
  }

  pending.verified = true;
  pendingRequests.set(email, pending);

  if (supabase) {
    const { error } = await db('otp_requests')
      .update({ verified: true })
      .eq('email', email);

    if (error) {
      return res.status(400).json({ success: false, message: error.message });
    }

    if (pending.action === 'signup') {
      const { error: upsertError } = await db('app_users').upsert({
        email,
        username: pending.username,
        password_hash: pending.passwordHash,
        role: 'user'
      }, { onConflict: 'email' });

      if (upsertError) {
        return res.status(400).json({ success: false, message: upsertError.message });
      }

      await db('otp_requests').delete().eq('email', email);
      pendingRequests.delete(email);
      return res.json({ success: true, action: 'signup' });
    }
  }

  return res.json({ success: true, action: pending.action });
});

app.post('/api/reset-password', async (req, res) => {
  const { email, newPassword } = req.body || {};

  if (!email || !newPassword) {
    return res.status(400).json({ success: false, message: 'Email and new password are required' });
  }

  const pending = pendingRequests.get(email);
  if (!pending || pending.action !== 'reset' || !pending.verified) {
    return res.status(400).json({ success: false, message: 'OTP verification required first' });
  }

  const passwordHash = await bcrypt.hash(newPassword, 10);

  if (supabase) {
    const { error } = await db('app_users').upsert({
      email,
      username: pending.username,
      password_hash: passwordHash,
      role: 'user'
    }, { onConflict: 'email' });

    if (error) {
      return res.status(400).json({ success: false, message: error.message });
    }

    await db('otp_requests').delete().eq('email', email);
  } else {
    const user = fallbackUsers.find((item) => item.email === email);
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    user.passwordHash = passwordHash;
  }

  pendingRequests.delete(email);
  return res.json({ success: true });
});

enableTerminalStopCommand();

server = app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  console.log(hasSupabase ? 'Supabase table mode enabled' : 'Supabase env not configured, using local fallback mode');
});
