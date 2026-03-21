const functions = require('firebase-functions');
const admin = require('firebase-admin');

admin.initializeApp();
const db = admin.firestore();

// ============================================================
// PAYROLL FUNCTIONS
// ============================================================

/**
 * Calculate PAYE tax for an annual gross salary (South Africa tax tables 2025)
 */
function calculateAnnualPAYE(annualGross) {
    let tax = 0;
    if (annualGross > 1817000) {
        tax = 644489 + (annualGross - 1817000) * 0.45;
    } else if (annualGross > 857900) {
        tax = 251258 + (annualGross - 857900) * 0.41;
    } else if (annualGross > 673000) {
        tax = 179147 + (annualGross - 673000) * 0.39;
    } else if (annualGross > 512800) {
        tax = 121475 + (annualGross - 512800) * 0.36;
    } else if (annualGross > 370500) {
        tax = 77362 + (annualGross - 370500) * 0.31;
    } else if (annualGross > 237100) {
        tax = 42678 + (annualGross - 237100) * 0.26;
    } else {
        tax = annualGross * 0.18;
    }
    const rebate = 17235; // Primary rebate for under 65
    tax -= rebate;
    return tax > 0 ? tax : 0;
}

/**
 * HTTP Function: Process payroll for a single employee
 */
exports.processPayroll = functions.https.onCall(async (data, context) => {
    if (!context.auth) {
        throw new functions.https.HttpsError('unauthenticated', 'Must be authenticated');
    }

    const { employeeId, grossSalary, period, deductions = {} } = data;

    const empDoc = await db.collection('employees').doc(String(employeeId)).get();
    if (!empDoc.exists) {
        throw new functions.https.HttpsError('not-found', 'Employee not found');
    }
    const employee = empDoc.data();

    const annualGross = grossSalary * 12;
    const annualPAYE = calculateAnnualPAYE(annualGross);
    const monthlyPAYE = annualPAYE / 12;

    const uifThreshold = 17712;
    const uifBase = Math.min(grossSalary, uifThreshold);
    const uif = uifBase * 0.01;

    const pension = deductions.pension || 0;
    const medical = deductions.medical || 0;

    const totalDeductions = monthlyPAYE + uif + pension + medical;
    const netPay = grossSalary - totalDeductions;

    const payrollRecord = {
        employeeId,
        employeeName: employee.name,
        period,
        grossSalary,
        paye: Math.round(monthlyPAYE * 100) / 100,
        uif: Math.round(uif * 100) / 100,
        pension,
        medical,
        totalDeductions: Math.round(totalDeductions * 100) / 100,
        net: Math.round(netPay * 100) / 100,
        processedBy: context.auth.uid,
        processedAt: admin.firestore.FieldValue.serverTimestamp(),
        status: 'Processed'
    };

    const payrollRef = await db.collection('payrolls').add(payrollRecord);

    await db.collection('auditLog').add({
        action: 'PAYROLL_PROCESSED',
        employeeId,
        employeeName: employee.name,
        period,
        net: payrollRecord.net,
        processedBy: context.auth.uid,
        timestamp: admin.firestore.FieldValue.serverTimestamp()
    });

    return { payrollId: payrollRef.id, ...payrollRecord };
});

/**
 * Scheduled Function: Run monthly payroll reminder on 25th of each month
 */
exports.monthlyPayrollReminder = functions.pubsub
    .schedule('0 8 25 * *')
    .timeZone('Africa/Johannesburg')
    .onRun(async (context) => {
        const now = new Date();
        const month = now.toLocaleString('en-ZA', { month: 'long', year: 'numeric' });

        const usersSnap = await db.collection('users')
            .where('role', '==', 'admin')
            .get();

        const batch = db.batch();
        usersSnap.forEach(userDoc => {
            const notifRef = db.collection('notifications').doc();
            batch.set(notifRef, {
                type: 'payroll_reminder',
                message: `Monthly payroll reminder: Please process payroll for ${month}`,
                recipient: userDoc.id,
                role: 'admin',
                read: false,
                createdAt: admin.firestore.FieldValue.serverTimestamp()
            });
        });

        await batch.commit();
        functions.logger.info(`Monthly payroll reminder sent for ${month}`);
        return null;
    });

// ============================================================
// LEAVE MANAGEMENT FUNCTIONS
// ============================================================

/**
 * Firestore Trigger: Notify admin when a new leave request is submitted
 */
exports.onLeaveSubmitted = functions.firestore
    .document('leaves/{leaveId}')
    .onCreate(async (snap, context) => {
        const leave = snap.data();

        const empSnap = await db.collection('employees')
            .where('id', '==', leave.employeeIndex + 1)
            .limit(1)
            .get();
        const empName = empSnap.empty ? 'Unknown Employee' : empSnap.docs[0].data().name;

        const adminSnap = await db.collection('users')
            .where('role', '==', 'admin')
            .get();

        const batch = db.batch();
        adminSnap.forEach(adminDoc => {
            const notifRef = db.collection('notifications').doc();
            batch.set(notifRef, {
                type: 'leave_request',
                message: `New leave request from ${empName}: ${leave.type} from ${leave.startDate} to ${leave.endDate}`,
                leaveId: context.params.leaveId,
                recipient: adminDoc.id,
                role: 'admin',
                read: false,
                createdAt: admin.firestore.FieldValue.serverTimestamp()
            });
        });

        await batch.commit();
        functions.logger.info(`Leave notification sent for ${empName}`);
        return null;
    });

/**
 * Firestore Trigger: Notify employee when leave is approved/rejected
 */
exports.onLeaveStatusChanged = functions.firestore
    .document('leaves/{leaveId}')
    .onUpdate(async (change, context) => {
        const before = change.before.data();
        const after = change.after.data();

        if (before.status === after.status) return null;
        if (after.status === 'Pending') return null;

        const userSnap = await db.collection('users')
            .where('employeeIndex', '==', after.employeeIndex)
            .limit(1)
            .get();

        if (userSnap.empty) return null;
        const userId = userSnap.docs[0].id;

        const statusText = after.status === 'Approved' ? 'approved ✅' : 'rejected ❌';
        await db.collection('notifications').add({
            type: 'leave_status',
            message: `Your ${after.type} leave request has been ${statusText}`,
            leaveId: context.params.leaveId,
            recipient: userId,
            role: 'employee',
            read: false,
            createdAt: admin.firestore.FieldValue.serverTimestamp()
        });

        return null;
    });

// ============================================================
// EMPLOYEE MANAGEMENT FUNCTIONS
// ============================================================

/**
 * HTTP Function: Onboard a new employee
 */
exports.onboardEmployee = functions.https.onCall(async (data, context) => {
    if (!context.auth) {
        throw new functions.https.HttpsError('unauthenticated', 'Must be authenticated');
    }

    const { employee } = data;

    const empRef = await db.collection('employees').add({
        ...employee,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        createdBy: context.auth.uid
    });

    await db.collection('auditLog').add({
        action: 'EMPLOYEE_ONBOARDED',
        employeeId: empRef.id,
        employeeName: employee.name,
        createdBy: context.auth.uid,
        timestamp: admin.firestore.FieldValue.serverTimestamp()
    });

    const adminSnap = await db.collection('users').where('role', '==', 'admin').get();
    const batch = db.batch();
    adminSnap.forEach(adminDoc => {
        const notifRef = db.collection('notifications').doc();
        batch.set(notifRef, {
            type: 'employee_onboarded',
            message: `New employee onboarded: ${employee.name}`,
            employeeId: empRef.id,
            recipient: adminDoc.id,
            role: 'admin',
            read: false,
            createdAt: admin.firestore.FieldValue.serverTimestamp()
        });
    });
    await batch.commit();

    return { employeeId: empRef.id };
});

/**
 * HTTP Function: Set user role (admin only)
 */
exports.setUserRole = functions.https.onCall(async (data, context) => {
    if (!context.auth) {
        throw new functions.https.HttpsError('unauthenticated', 'Must be authenticated');
    }

    const callerDoc = await db.collection('users').doc(context.auth.uid).get();
    if (!callerDoc.exists || callerDoc.data().role !== 'admin') {
        throw new functions.https.HttpsError('permission-denied', 'Only admins can set roles');
    }

    const { uid, role, employeeIndex } = data;

    await admin.auth().setCustomUserClaims(uid, { role, employeeIndex });

    await db.collection('users').doc(uid).set({
        role,
        employeeIndex: employeeIndex || null,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedBy: context.auth.uid
    }, { merge: true });

    return { success: true };
});

// ============================================================
// COMPLIANCE & CERTIFICATION FUNCTIONS
// ============================================================

/**
 * Scheduled Function: Check for expiring certifications daily
 */
exports.checkExpiringCertifications = functions.pubsub
    .schedule('0 7 * * *')
    .timeZone('Africa/Johannesburg')
    .onRun(async (context) => {
        const now = new Date();
        const thirtyDaysFromNow = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
        const thirtyDaysStr = thirtyDaysFromNow.toISOString().split('T')[0];
        const nowStr = now.toISOString().split('T')[0];

        const certsSnap = await db.collection('certifications')
            .where('expiry', '>=', nowStr)
            .where('expiry', '<=', thirtyDaysStr)
            .get();

        if (certsSnap.empty) return null;

        const adminSnap = await db.collection('users').where('role', '==', 'admin').get();
        const batch = db.batch();

        certsSnap.forEach(certDoc => {
            const cert = certDoc.data();
            adminSnap.forEach(adminDoc => {
                const notifRef = db.collection('notifications').doc();
                batch.set(notifRef, {
                    type: 'cert_expiring',
                    message: `Certification "${cert.certName}" for ${cert.employeeName} expires on ${cert.expiry}`,
                    certId: certDoc.id,
                    recipient: adminDoc.id,
                    role: 'admin',
                    read: false,
                    createdAt: admin.firestore.FieldValue.serverTimestamp()
                });
            });
        });

        await batch.commit();
        functions.logger.info(`Checked ${certsSnap.size} expiring certifications`);
        return null;
    });

// ============================================================
// WELLNESS FUNCTIONS
// ============================================================

/**
 * HTTP Function: Process wellness survey submission
 */
exports.submitWellnessSurvey = functions.https.onCall(async (data, context) => {
    if (!context.auth) {
        throw new functions.https.HttpsError('unauthenticated', 'Must be authenticated');
    }

    const { surveyId, employeeIndex, responses } = data;

    const scores = Object.values(responses).map(v => Number(v)).filter(v => !isNaN(v));
    const avgScore = scores.length > 0 ? scores.reduce((a, b) => a + b, 0) / scores.length : 0;
    const wellnessScore = Math.round((avgScore / 10) * 100);

    await db.collection('wellnessResponses').add({
        surveyId,
        employeeIndex,
        responses,
        wellnessScore,
        submittedAt: admin.firestore.FieldValue.serverTimestamp(),
        submittedBy: context.auth.uid
    });

    const empSnap = await db.collection('employees')
        .where('id', '==', employeeIndex + 1)
        .limit(1)
        .get();
    if (!empSnap.empty) {
        await empSnap.docs[0].ref.update({ wellnessScore });
    }

    if (wellnessScore < 40) {
        const adminSnap = await db.collection('users').where('role', '==', 'admin').get();
        const batch = db.batch();
        adminSnap.forEach(adminDoc => {
            const notifRef = db.collection('notifications').doc();
            batch.set(notifRef, {
                type: 'wellness_alert',
                message: `Employee wellness alert: Score of ${wellnessScore}% detected for employee index ${employeeIndex}`,
                employeeIndex,
                recipient: adminDoc.id,
                role: 'admin',
                read: false,
                priority: 'high',
                createdAt: admin.firestore.FieldValue.serverTimestamp()
            });
        });
        await batch.commit();
    }

    return { wellnessScore };
});

// ============================================================
// AUDIT & SECURITY FUNCTIONS
// ============================================================

/**
 * Firestore Trigger: Log all employee record changes for audit trail
 */
exports.auditEmployeeChanges = functions.firestore
    .document('employees/{employeeId}')
    .onWrite(async (change, context) => {
        if (!change.before.exists && change.after.data()._isDefaultData) return null;

        const action = !change.before.exists ? 'CREATED' :
                       !change.after.exists ? 'DELETED' : 'UPDATED';

        await db.collection('auditLog').add({
            action: `EMPLOYEE_${action}`,
            employeeId: context.params.employeeId,
            before: change.before.exists ? change.before.data() : null,
            after: change.after.exists ? change.after.data() : null,
            timestamp: admin.firestore.FieldValue.serverTimestamp()
        });

        return null;
    });

/**
 * HTTP Function: Generate payroll summary report
 */
exports.generatePayrollReport = functions.https.onCall(async (data, context) => {
    if (!context.auth) {
        throw new functions.https.HttpsError('unauthenticated', 'Must be authenticated');
    }

    const callerDoc = await db.collection('users').doc(context.auth.uid).get();
    if (!callerDoc.exists || callerDoc.data().role !== 'admin') {
        throw new functions.https.HttpsError('permission-denied', 'Admin access required');
    }

    const { period } = data;
    const payrollsSnap = await db.collection('payrolls')
        .where('period', '==', period)
        .get();

    let totalGross = 0;
    let totalNet = 0;
    let totalPAYE = 0;
    let totalUIF = 0;
    let employeeCount = 0;
    const payrollDetails = [];

    payrollsSnap.forEach(doc => {
        const p = doc.data();
        totalGross += p.grossSalary || 0;
        totalNet += p.net || 0;
        totalPAYE += p.paye || 0;
        totalUIF += p.uif || 0;
        employeeCount++;
        payrollDetails.push({
            id: doc.id,
            employeeName: p.employeeName,
            gross: p.grossSalary,
            paye: p.paye,
            uif: p.uif,
            net: p.net
        });
    });

    return {
        period,
        employeeCount,
        totalGross: Math.round(totalGross * 100) / 100,
        totalNet: Math.round(totalNet * 100) / 100,
        totalPAYE: Math.round(totalPAYE * 100) / 100,
        totalUIF: Math.round(totalUIF * 100) / 100,
        payrollDetails,
        generatedAt: new Date().toISOString()
    };
});
