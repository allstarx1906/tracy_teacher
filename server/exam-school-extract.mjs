/**
 * School / midterm PDF adapter — structural dispatch only.
 * B1 full-paper logic lives in exam-b1-midterm-extract.mjs; generic school parsing in exam-extract.mjs.
 */
export {
  isSchoolStructuredExamDocument,
  parseSchoolQuestionsFromPages,
} from './exam-extract.mjs';

export {
  isB1AchievementMidtermDocument,
  parseB1AchievementMidtermFromPages,
} from './exam-b1-midterm-extract.mjs';
