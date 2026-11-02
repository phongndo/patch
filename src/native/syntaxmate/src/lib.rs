//! The C interface src/native/syntaxmate.zig drives: a language is a
//! syntaxmate tokenizer over the grammars its root reaches, kept for the
//! process with its compiled patterns, and a run is one file's state, fed a
//! line at a time. A language serves one run at a time; the caller locks.
//!
//! Tokens come back through callbacks as byte ranges of the line and a scope
//! stack number. A run numbers each distinct stack from 0 in the order it
//! first appears and reports its scope names before the first token that uses
//! it, so the caller works out what a stack means once.

use std::{collections::HashMap, ffi::c_void, slice, str, sync::OnceLock, time::Instant};

use syntaxmate::{
    Error, GrammarRegistry, HighlightStatus, ScopeStackId, Tokenizer, TokenizerOptions,
    TokenizerState,
};

/// Nanoseconds on a monotonic clock, for time budgets: Rust's, so every
/// platform Patch builds for has one.
#[unsafe(no_mangle)]
pub extern "C" fn patch_sm_monotonic_ns() -> u64 {
    static START: OnceLock<Instant> = OnceLock::new();
    START.get_or_init(Instant::now).elapsed().as_nanos() as u64
}

/// A borrowed byte string.
#[repr(C)]
pub struct PatchStr {
    pub ptr: *const u8,
    pub len: usize,
}

impl PatchStr {
    fn of(text: &str) -> Self {
        Self {
            ptr: text.as_ptr(),
            len: text.len(),
        }
    }
    unsafe fn bytes<'a>(&self) -> &'a [u8] {
        if self.len == 0 {
            &[]
        } else {
            unsafe { slice::from_raw_parts(self.ptr, self.len) }
        }
    }
}

pub struct Language {
    tokenizer: Tokenizer,
}

/// A language from grammar JSON texts, the root first. A grammar that doesn't
/// load is left out, as a missing include would be; when the root doesn't,
/// there is no language and this returns null. Lines of `max_line_bytes` or
/// more are left untokenized, with the state as it was.
///
/// # Safety
/// `grammars` points to `count` valid byte strings.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn patch_sm_language_new(
    grammars: *const PatchStr,
    count: usize,
    max_line_bytes: usize,
) -> *mut Language {
    if grammars.is_null() || count == 0 {
        return std::ptr::null_mut();
    }
    let grammars = unsafe { slice::from_raw_parts(grammars, count) };
    let mut registry = GrammarRegistry::new();
    let mut root = None;
    for (i, grammar) in grammars.iter().enumerate() {
        let Ok(json) = str::from_utf8(unsafe { grammar.bytes() }) else {
            continue;
        };
        match registry.add_json(json) {
            Ok(id) if i == 0 => root = Some(id),
            _ => {}
        }
    }
    let Some(root) = root else {
        return std::ptr::null_mut();
    };
    // No line-result cache: every line is tokenized.
    let options = TokenizerOptions {
        max_line_bytes,
        line_cache_entries: 0,
    };
    match Tokenizer::new(&registry, root, options) {
        Ok(tokenizer) => Box::into_raw(Box::new(Language { tokenizer })),
        Err(_) => std::ptr::null_mut(),
    }
}

/// # Safety
/// `language` is null or from `patch_sm_language_new`, and no run uses it.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn patch_sm_language_free(language: *mut Language) {
    if !language.is_null() {
        drop(unsafe { Box::from_raw(language) });
    }
}

pub struct Run {
    language: *mut Language,
    state: TokenizerState,
    stacks: HashMap<ScopeStackId, u32>,
    next_stack: u32,
    names: Vec<PatchStr>,
    /// For a line that isn't valid UTF-8: the line with U+FFFD for each
    /// invalid sequence, and where each of its bytes came from.
    lossy: String,
    origin: Vec<u32>,
}

/// Starts tokenizing a file at its first line.
///
/// # Safety
/// `language` is from `patch_sm_language_new`, outlives the run, and serves
/// no other run until this one is freed.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn patch_sm_run_new(language: *mut Language) -> *mut Run {
    let state = unsafe { &*language }.tokenizer.initial_state();
    Box::into_raw(Box::new(Run {
        language,
        state,
        stacks: HashMap::new(),
        next_stack: 0,
        names: Vec::new(),
        lossy: String::new(),
        origin: Vec::new(),
    }))
}

/// # Safety
/// `run` is null or from `patch_sm_run_new`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn patch_sm_run_free(run: *mut Run) {
    if !run.is_null() {
        drop(unsafe { Box::from_raw(run) });
    }
}

/// A new scope stack: its number and its scope names, outermost first,
/// valid during the call.
pub type StackFn =
    unsafe extern "C" fn(context: *mut c_void, stack: u32, names: *const PatchStr, count: usize);
/// Bytes [start, end) of the line carry stack `stack`.
pub type TokenFn = unsafe extern "C" fn(context: *mut c_void, start: u32, end: u32, stack: u32);
/// Whether to give up on the line: the caller's time is up or it was
/// cancelled.
pub type StopFn = unsafe extern "C" fn(context: *mut c_void) -> bool;

/// Tokenizes the next line, without its terminator. Returns 0 when the line
/// was tokenized completely, 1 when syntaxmate's work limits cut it short,
/// 2 when `on_stop` stopped it (some of its tokens may have been sent; the
/// run can't go on), and -1 when it couldn't be tokenized.
///
/// # Safety
/// `run` is from `patch_sm_run_new`; `line` points to `length` bytes.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn patch_sm_run_line(
    run: *mut Run,
    line: *const u8,
    length: usize,
    context: *mut c_void,
    on_stack: StackFn,
    on_token: TokenFn,
    on_stop: StopFn,
) -> i32 {
    let run = unsafe { &mut *run };
    let bytes = if length == 0 {
        &[][..]
    } else {
        unsafe { slice::from_raw_parts(line, length) }
    };
    let (text, mapped) = match str::from_utf8(bytes) {
        Ok(text) => (text, false),
        Err(_) => {
            run.lossy.clear();
            run.origin.clear();
            let mut at = 0u32;
            for chunk in bytes.utf8_chunks() {
                for (offset, _) in chunk.valid().char_indices() {
                    let width = chunk.valid()[offset..]
                        .chars()
                        .next()
                        .map_or(1, char::len_utf8);
                    run.origin
                        .extend(std::iter::repeat_n(at + offset as u32, width));
                }
                run.lossy.push_str(chunk.valid());
                at += chunk.valid().len() as u32;
                if !chunk.invalid().is_empty() {
                    run.lossy.push(char::REPLACEMENT_CHARACTER);
                    run.origin.extend(std::iter::repeat_n(
                        at,
                        char::REPLACEMENT_CHARACTER.len_utf8(),
                    ));
                    at += chunk.invalid().len() as u32;
                }
            }
            run.origin.push(at);
            // Borrow the lossy copy apart from the rest of the run.
            let lossy: &str = unsafe { &*(run.lossy.as_str() as *const str) };
            (lossy, true)
        }
    };
    let Run {
        language,
        state,
        stacks,
        next_stack,
        names,
        origin,
        ..
    } = run;
    let tokenizer = unsafe { &mut (**language).tokenizer };
    let mut stopped = false;
    let status = tokenizer.tokenize_line_with_interrupt(
        text,
        state,
        |token| {
            if stopped {
                return;
            }
            let range = token.range();
            let (start, end) = if mapped {
                (origin[range.start], origin[range.end])
            } else {
                (range.start as u32, range.end as u32)
            };
            let stack = match token.scope_stack() {
                Some(id) => match stacks.get(&id) {
                    Some(&number) => number,
                    None => {
                        // Reporting a stack copies all its names, which on a
                        // deeply nested line is the costly part: check first.
                        if unsafe { on_stop(context) } {
                            stopped = true;
                            return;
                        }
                        let number = *next_stack;
                        *next_stack += 1;
                        stacks.insert(id, number);
                        report(context, on_stack, number, &token, names);
                        number
                    }
                },
                // A stack without an identity is reported each time it appears.
                None => {
                    if unsafe { on_stop(context) } {
                        stopped = true;
                        return;
                    }
                    let number = *next_stack;
                    *next_stack += 1;
                    report(context, on_stack, number, &token, names);
                    number
                }
            };
            unsafe { on_token(context, start, end, stack) };
        },
        || unsafe { on_stop(context) },
    );
    match status {
        _ if stopped => 2,
        Err(Error::Interrupted) => 2,
        Ok(HighlightStatus::Complete) => 0,
        Ok(_) => 1,
        Err(_) => -1,
    }
}

fn report(
    context: *mut c_void,
    on_stack: StackFn,
    number: u32,
    token: &syntaxmate::Token,
    names: &mut Vec<PatchStr>,
) {
    names.clear();
    names.extend(token.scopes().map(PatchStr::of));
    unsafe { on_stack(context, number, names.as_ptr(), names.len()) };
}
